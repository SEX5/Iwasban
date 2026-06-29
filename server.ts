import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import zlib from "zlib";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://placeholder-url.supabase.co";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-key";

const isSupabaseConfigured = 
  supabaseUrl !== 'https://placeholder-url.supabase.co' && 
  supabaseKey !== 'placeholder-key';

const supabase = createClient(supabaseUrl, supabaseKey);

// Game API Helpers
const getGameHeaders = (token?: string) => {
  const headers: any = {
    "User-Agent": "UnityPlayer/2021.3.19f1 (UnityWebRequest/1.0, libcurl/7.84.0-DEV)",
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate",
    "X-Unity-Version": "2021.3.19f1"
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const isValidUrl = (urlStr: string | undefined): boolean => {
  if (!urlStr) return false;
  try {
    new URL(urlStr);
    return true;
  } catch (_) {
    return false;
  }
};

// API Routes
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Save Account API
app.post("/api/accounts/save", async (req, res) => {
  const { username, password, days = 30 } = req.body;

  if (!isSupabaseConfigured) {
    return res.status(400).json({ success: false, message: "Database Setup Required: Please provide NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the Secrets panel." });
  }

  if (!username || !password) {
    return res.status(400).json({ success: false, message: "Username and password required" });
  }

  const loginApi = process.env.LOGIN_API;
  const profilesApi = process.env.PROFILES_API;

  if (!isValidUrl(loginApi)) {
    return res.status(400).json({ success: false, message: "Configuration Required: Please set LOGIN_API in the Secrets panel to a valid absolute URL." });
  }

  if (!isValidUrl(profilesApi)) {
    return res.status(400).json({ success: false, message: "Configuration Required: Please set PROFILES_API in the Secrets panel to a valid absolute URL." });
  }

  try {
    // 1. Game Login
    const loginRes = await fetch(`${loginApi}/login`, {
      method: "POST",
      headers: { 
        ...getGameHeaders(),
        "Content-Type": "application/x-www-form-urlencoded" 
      },
      body: new URLSearchParams({ username, password, project: "STREET" })
    });

    if (loginRes.status === 703) {
      return res.status(400).json({ success: false, banned: true, message: "Account is banned (Error 703)" });
    }

    const resText = await loginRes.text();
    let loginData: any = null;
    try {
      loginData = JSON.parse(resText);
    } catch (e) {
      console.error(`[Save Account Login] JSON parsing error. Status: ${loginRes.status}, Body:`, resText);
      return res.status(400).json({ 
        success: false, 
        message: `Game Server Error (Status ${loginRes.status}): Server returned invalid response. Check console logs. Response snippet: ${resText.slice(0, 150)}`
      });
    }

    const token = loginData?.d?.token;

    if (!token) {
      return res.status(400).json({ success: false, message: loginData?.e || `Login failed. Server returned: ${JSON.stringify(loginData)}` });
    }

    // 2. Fetch Profile
    const profileRes = await fetch(`${profilesApi}`, {
      headers: getGameHeaders(token)
    });
    const profileData = await profileRes.json();

    // 3. Save to Supabase
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + parseInt(days));

    const { error } = await supabase
      .from("accounts")
      .upsert({
        email: username.toLowerCase(),
        password,
        last_token: token,
        profile_data: profileData,
        expiry_date: expiryDate.toISOString(),
        status: "active",
        updated_at: new Date().toISOString()
      }, { onConflict: "email" });

    if (error) throw error;

    // 3.5. Upload profile JSON to Supabase Storage
    try {
      // Ensure the 'profiles' bucket exists (public or private)
      await supabase.storage.createBucket("profiles", { public: true }).catch(() => {
        // Ignore error if it already exists or if we don't have create bucket permissions
      });

      const fileName = `${username.toLowerCase().replace(/[@.]/g, "_")}_profile.json`;
      const fileBuffer = Buffer.from(JSON.stringify(profileData, null, 2));

      const { error: uploadError } = await supabase.storage
        .from("profiles")
        .upload(fileName, fileBuffer, {
          contentType: "application/json",
          upsert: true
        });

      if (uploadError) {
        console.warn("Supabase Storage Upload Warning:", uploadError.message);
      } else {
        console.log(`Successfully backed up profile for ${username} to Supabase Storage: ${fileName}`);
      }
    } catch (storageErr: any) {
      console.warn("Supabase Storage Upload Failed:", storageErr.message);
    }

    res.json({ success: true, message: "Account saved and backed up successfully", expiryDate: expiryDate.toLocaleDateString() });
  } catch (error: any) {
    console.error("Save error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Download Profile JSON from Storage
app.get("/api/storage/download", async (req, res) => {
  const { email } = req.query;
  if (!isSupabaseConfigured) {
    return res.status(400).json({ success: false, message: "Database Setup Required: Please provide NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the Secrets panel." });
  }
  if (!email || typeof email !== "string") {
    return res.status(400).json({ success: false, message: "Email parameter required." });
  }

  try {
    const fileName = `${email.toLowerCase().replace(/[@.]/g, "_")}_profile.json`;
    
    // Attempt to download from Storage
    const { data, error } = await supabase.storage
      .from("profiles")
      .download(fileName);

    if (error || !data) {
      console.log(`File ${fileName} not found in Supabase Storage, falling back to Database.`);
      // Fallback: check database
      const { data: dbAccount } = await supabase
        .from("accounts")
        .select("profile_data")
        .eq("email", email.toLowerCase())
        .single();

      if (dbAccount && dbAccount.profile_data) {
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.setHeader("Content-Type", "application/json");
        return res.send(JSON.stringify(dbAccount.profile_data, null, 2));
      }
      throw error || new Error("Profile file not found in database or storage");
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "application/json");
    res.send(buffer);
  } catch (error: any) {
    console.error("Storage download error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to download profile" });
  }
});

// Unban Account API
app.post("/api/accounts/unban", async (req, res) => {
  const { username } = req.body;

  if (!isSupabaseConfigured) {
    return res.status(400).json({ success: false, message: "Database Setup Required: Please provide NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the Secrets panel." });
  }

  const loginApi = process.env.LOGIN_API;
  const profilesApi = process.env.PROFILES_API;
  const registerApi = process.env.REGISTER_API;

  if (!isValidUrl(loginApi)) {
    return res.status(400).json({ success: false, message: "Configuration Required: Please set LOGIN_API in the Secrets panel to a valid absolute URL." });
  }

  if (!isValidUrl(profilesApi)) {
    return res.status(400).json({ success: false, message: "Configuration Required: Please set PROFILES_API in the Secrets panel to a valid absolute URL." });
  }

  if (!isValidUrl(registerApi)) {
    return res.status(400).json({ success: false, message: "Configuration Required: Please set REGISTER_API in the Secrets panel to a valid absolute URL." });
  }

  try {
    // 1. Fetch saved profile
    const { data: dbAccount, error: dbError } = await supabase
      .from("accounts")
      .select("*")
      .eq("email", username.toLowerCase())
      .single();

    if (dbError || !dbAccount) {
      return res.status(404).json({ success: false, message: "Account profile not found in database" });
    }

    const { password } = dbAccount;

    // 2. Initial Login
    const loginRes = await fetch(`${loginApi}/login`, {
      method: "POST",
      headers: { 
        ...getGameHeaders(),
        "Content-Type": "application/x-www-form-urlencoded" 
      },
      body: new URLSearchParams({ username, password, project: "STREET" })
    });
    const initialText = await loginRes.text();
    let loginData: any = null;
    try {
      loginData = JSON.parse(initialText);
    } catch (e) {
      throw new Error(`Failed to parse login response (Status ${loginRes.status}): ${initialText.slice(0, 150)}`);
    }
    const token = loginData?.d?.token;

    if (!token) throw new Error(loginData?.e || "Failed to authenticate with game servers during initial login");

    // 3. Delete Account
    await fetch(`${loginApi}/delete`, {
      method: "POST",
      headers: { ...getGameHeaders(token), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password, project: "STREET" })
    });

    await sleep(5000);

    // 4. Register Account
    await fetch(`${registerApi}`, {
      method: "POST",
      headers: { 
        ...getGameHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded' 
      },
      body: new URLSearchParams({ username, password, project: "STREET" })
    });

    await sleep(3000);

    // 5. Final Login
    const finalLoginRes = await fetch(`${loginApi}/login`, {
      method: "POST",
      headers: { 
        ...getGameHeaders(),
        'Content-Type': 'application/x-www-form-urlencoded' 
      },
      body: new URLSearchParams({ username, password, project: "STREET" })
    });
    const finalText = await finalLoginRes.text();
    let finalLoginData: any = null;
    try {
      finalLoginData = JSON.parse(finalText);
    } catch (e) {
      throw new Error(`Failed to parse final login response (Status ${finalLoginRes.status}): ${finalText.slice(0, 150)}`);
    }
    const finalToken = finalLoginData?.d?.token;

    if (!finalToken) throw new Error(finalLoginData?.e || "Failed to authenticate with game servers during final login");

    // 6. Upload Profile
    const uploadRes = await fetch(`${profilesApi}`, {
      method: "POST",
      headers: { ...getGameHeaders(finalToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(dbAccount.profile_data)
    });

    if (uploadRes.status === 200) {
      await supabase
        .from("accounts")
        .update({ status: "active", last_sync: new Date().toISOString() })
        .eq("email", username.toLowerCase());

      res.json({ success: true, message: "Unbanned successfully" });
    } else {
      throw new Error(`Profile upload failed with code: ${uploadRes.status}`);
    }
  } catch (error: any) {
    console.error("Unban error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Daemon logs buffer
interface DaemonLog {
  timestamp: string;
  type: "sys" | "proc" | "success" | "error" | "info";
  message: string;
}

const daemonLogs: DaemonLog[] = [];

function addDaemonLog(type: "sys" | "proc" | "success" | "error" | "info", message: string) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, type, message };
  daemonLogs.push(entry);
  if (daemonLogs.length > 300) {
    daemonLogs.shift();
  }
  console.log(`[Auto-Checker][${type.toUpperCase()}] ${message}`);
}

app.get("/api/daemon/logs", (req, res) => {
  res.json({ logs: daemonLogs });
});

// Endpoint to manually or externally trigger the background check
app.get("/api/daemon/run", async (req, res) => {
  addDaemonLog("sys", "External trigger received. Starting manual backup cycle...");
  // Run it in the background so the request doesn't timeout
  runAutomaticBackupCheck().catch(err => {
    addDaemonLog("error", `Manual trigger failed: ${err.message}`);
  });
  res.json({ success: true, message: "Backup cycle initiated." });
});

// Automated 30-Minute Health-Check, Backup & Auto-Restore System
async function runAutomaticBackupCheck() {
  if (!isSupabaseConfigured) {
    addDaemonLog("info", "Supabase is not configured, skipping background check.");
    return;
  }

  const loginApi = process.env.LOGIN_API;
  const profilesApi = process.env.PROFILES_API;
  const registerApi = process.env.REGISTER_API;

  if (!isValidUrl(loginApi) || !isValidUrl(profilesApi) || !isValidUrl(registerApi)) {
    addDaemonLog("info", "API configurations are incomplete or invalid URLs, skipping background check.");
    return;
  }

  addDaemonLog("sys", "Starting automated 30-minute health-check and backup cycle...");

  try {
    const { data: accounts, error } = await supabase
      .from("accounts")
      .select("*");

    if (error) {
      addDaemonLog("error", `Error fetching accounts from database: ${error.message}`);
      return;
    }

    if (!accounts || accounts.length === 0) {
      addDaemonLog("info", "No accounts found to process in database.");
      return;
    }

    addDaemonLog("sys", `Found ${accounts.length} account(s) to evaluate.`);

    for (const account of accounts) {
      const email = account.email.toLowerCase();
      const password = account.password;
      if (!password) {
        addDaemonLog("info", `Skipping ${email} due to missing password.`);
        continue;
      }

      addDaemonLog("proc", `Performing health check for ${email}...`);

      try {
        // 1. Check account health via game login
        const loginRes = await fetch(`${loginApi}/login`, {
          method: "POST",
          headers: { 
            ...getGameHeaders(),
            "Content-Type": "application/x-www-form-urlencoded" 
          },
          body: new URLSearchParams({ username: email, password, project: "STREET" })
        });

        const isBanned = loginRes.status === 703;
        let loginData: any = null;
        let token = null;

        if (!isBanned) {
          try {
            const resText = await loginRes.text();
            loginData = JSON.parse(resText);
            token = loginData?.d?.token;
          } catch (e: any) {
            addDaemonLog("error", `Failed to parse login json for ${email}: ${e.message}`);
          }
        }

        const isHealthy = !isBanned && !!token;

        if (isHealthy) {
          addDaemonLog("success", `Account ${email} is HEALTHY. Creating fresh backup...`);

          const fileName = `${email.replace(/[@.]/g, "_")}_profile.json`;

          // A. Delete old profile JSON from Storage
          addDaemonLog("proc", `Deleting old stored profile JSON for ${email} from Storage...`);
          await supabase.storage
            .from("profiles")
            .remove([fileName])
            .catch((err) => addDaemonLog("error", `Storage removal warning for ${email}: ${err.message}`));

          // B. Fetch latest profile
          const profileRes = await fetch(`${profilesApi}`, {
            headers: getGameHeaders(token)
          });
          const profileData = await profileRes.json();

          // C. Save latest profile to database and upload to storage (acts as fresh backup)
          const { error: dbUpdateError } = await supabase
            .from("accounts")
            .update({
              profile_data: profileData,
              status: "active",
              last_token: token,
              last_sync: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq("email", email);

          if (dbUpdateError) {
            addDaemonLog("error", `Failed to update DB for ${email}: ${dbUpdateError.message}`);
          }

          try {
            const fileBuffer = Buffer.from(JSON.stringify(profileData, null, 2));
            const { error: uploadError } = await supabase.storage
              .from("profiles")
              .upload(fileName, fileBuffer, {
                contentType: "application/json",
                upsert: true
              });

            if (uploadError) {
              addDaemonLog("error", `Storage backup failed for ${email}: ${uploadError.message}`);
            } else {
              addDaemonLog("success", `Successfully uploaded backup file for ${email} to storage.`);
            }
          } catch (storageErr: any) {
            addDaemonLog("error", `Storage upload exception for ${email}: ${storageErr.message}`);
          }

        } else {
          // NOT HEALTHY / BANNED
          addDaemonLog("error", `Account ${email} is UNHEALTHY or BANNED (Code 703). Initiating auto-restore process...`);

          if (!account.profile_data) {
            addDaemonLog("error", `No backup profile data stored in database for ${email}, cannot perform auto-restore.`);
            await supabase
              .from("accounts")
              .update({
                status: "banned",
                updated_at: new Date().toISOString()
              })
              .eq("email", email);
            continue;
          }

          // A. Perform Auto-Restore
          let deleteToken = token;
          if (!deleteToken) {
            const initialLoginRes = await fetch(`${loginApi}/login`, {
              method: "POST",
              headers: { 
                ...getGameHeaders(),
                "Content-Type": "application/x-www-form-urlencoded" 
              },
              body: new URLSearchParams({ username: email, password, project: "STREET" })
            });
            try {
              const initialLoginText = await initialLoginRes.text();
              const initialLoginData: any = JSON.parse(initialLoginText);
              deleteToken = initialLoginData?.d?.token;
            } catch (e: any) {
              addDaemonLog("error", `Failed to parse initial login for auto-restore of ${email}: ${e.message}`);
            }
          }

          // 1) Delete account
          if (deleteToken) {
            addDaemonLog("proc", `Auto-Restore [1/4] - Purging banned account ${email} on game servers...`);
            await fetch(`${loginApi}/delete`, {
              method: "POST",
              headers: { ...getGameHeaders(deleteToken), 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ username: email, password, project: "STREET" })
            }).catch(e => addDaemonLog("error", `Account deletion error for ${email}: ${e.message || e}`));
            await sleep(5000);
          }

          // 2) Register account
          addDaemonLog("proc", `Auto-Restore [2/4] - Registering clean account ${email}...`);
          await fetch(`${registerApi}`, {
            method: "POST",
            headers: { 
              ...getGameHeaders(),
              'Content-Type': 'application/x-www-form-urlencoded' 
            },
            body: new URLSearchParams({ username: email, password, project: "STREET" })
          }).catch(e => addDaemonLog("error", `Account registration error for ${email}: ${e.message || e}`));
          await sleep(3000);

          // 3) Final Login
          addDaemonLog("proc", `Auto-Restore [3/4] - Logging into new account ${email} to retrieve token...`);
          const finalLoginRes = await fetch(`${loginApi}/login`, {
            method: "POST",
            headers: { 
              ...getGameHeaders(),
              'Content-Type': 'application/x-www-form-urlencoded' 
            },
            body: new URLSearchParams({ username: email, password, project: "STREET" })
          });
          let finalToken = null;
          try {
            const finalLoginText = await finalLoginRes.text();
            const finalLoginData: any = JSON.parse(finalLoginText);
            finalToken = finalLoginData?.d?.token;
          } catch (e: any) {
            addDaemonLog("error", `Failed to parse final login for auto-restore of ${email}: ${e.message}`);
          }

          if (!finalToken) {
            throw new Error(`Auto-restore failed at final login stage for ${email}: Unable to fetch final token`);
          }

          // 4) Upload stored profile
          addDaemonLog("proc", `Auto-Restore [4/4] - Injecting database profile backup for ${email}...`);
          const uploadRes = await fetch(`${profilesApi}`, {
            method: "POST",
            headers: { ...getGameHeaders(finalToken), 'Content-Type': 'application/json' },
            body: JSON.stringify(account.profile_data)
          });

          if (uploadRes.status !== 200) {
            throw new Error(`Profile upload failed with code: ${uploadRes.status}`);
          }

          addDaemonLog("success", `Auto-Restore SUCCESS for ${email}. Status has been reactivated.`);

          // B. Delete stored profile json from Storage
          addDaemonLog("proc", `Deleting stored profile JSON for ${email} post-restore from Storage...`);
          const fileName = `${email.replace(/[@.]/g, "_")}_profile.json`;
          await supabase.storage
            .from("profiles")
            .remove([fileName])
            .catch((err) => addDaemonLog("error", `Storage removal post-restore warning for ${email}: ${err.message}`));

          // C. Go back to backup it again
          addDaemonLog("proc", `Backing up newly restored account ${email}...`);
          const freshProfileRes = await fetch(`${profilesApi}`, {
            headers: getGameHeaders(finalToken)
          });
          const freshProfileData = await freshProfileRes.json();

          // Save in Database
          await supabase
            .from("accounts")
            .update({
              profile_data: freshProfileData,
              status: "active",
              last_token: finalToken,
              last_sync: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq("email", email);

          // Upload backup to Storage
          try {
            const fileBuffer = Buffer.from(JSON.stringify(freshProfileData, null, 2));
            await supabase.storage
              .from("profiles")
              .upload(fileName, fileBuffer, {
                contentType: "application/json",
                upsert: true
              });
            addDaemonLog("success", `Successfully completed fresh backup post-restore for ${email}.`);
          } catch (storageErr: any) {
            addDaemonLog("error", `Storage upload post-restore error for ${email}: ${storageErr.message}`);
          }
        }
      } catch (innerErr: any) {
        addDaemonLog("error", `Exception while processing ${email}: ${innerErr.message || innerErr}`);
      }
    }
  } catch (err: any) {
    addDaemonLog("error", `Critical exception in background check cycle: ${err.message || err}`);
  }
}

// Vite Middleware for development
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    
    // Register background daemon check (every 30 minutes)
    setInterval(runAutomaticBackupCheck, 30 * 60 * 1000);
    // Trigger an initial check in 10 seconds to process existing accounts immediately
    setTimeout(runAutomaticBackupCheck, 10000);
  });
}

startServer();
