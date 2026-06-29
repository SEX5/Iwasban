import React, { useState, useEffect, useRef, useMemo } from 'react';
import { supabase, isSupabaseConfigured } from '@/src/lib/supabase';
import { Account, Stats } from '@/src/types';
import { 
  Users, 
  ShieldCheck, 
  ShieldAlert, 
  Clock, 
  Plus, 
  Trash2, 
  Unlock, 
  RefreshCcw,
  Search,
  CheckCircle2,
  AlertCircle,
  Terminal,
  Zap,
  Download,
  Info
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/src/lib/utils';

interface LogEntry {
  timestamp: string;
  type: 'info' | 'success' | 'error' | 'proc' | 'sys';
  message: string;
  source?: 'app' | 'daemon';
  rawTime?: number;
}

export default function Dashboard() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, active: 0, banned: 0, expired: 0 });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [daemonLogs, setDaemonLogs] = useState<LogEntry[]>([]);
  const [consoleTab, setConsoleTab] = useState<'all' | 'app' | 'daemon'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProfileJson, setSelectedProfileJson] = useState<string | null>(null);
  const [selectedProfileEmail, setSelectedProfileEmail] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [accountToDelete, setAccountToDelete] = useState<string | null>(null);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  async function fetchDaemonLogs() {
    try {
      const res = await fetch('/api/daemon/logs');
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.logs)) {
          const formatted: LogEntry[] = data.logs.map((l: any) => {
            const date = new Date(l.timestamp);
            return {
              timestamp: date.toLocaleTimeString('en-GB', { hour12: false }),
              type: l.type,
              message: l.message,
              source: 'daemon',
              rawTime: date.getTime()
            };
          });
          setDaemonLogs(formatted);
        }
      }
    } catch (err) {
      console.error('Failed to fetch daemon logs:', err);
    }
  }

  useEffect(() => {
    fetchDaemonLogs();
    const interval = setInterval(fetchDaemonLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  const displayedLogs = useMemo(() => {
    if (consoleTab === 'app') {
      return logs;
    }
    if (consoleTab === 'daemon') {
      return daemonLogs;
    }
    const combined = [...logs, ...daemonLogs];
    combined.sort((a, b) => (a.rawTime || 0) - (b.rawTime || 0));
    return combined.slice(-150);
  }, [logs, daemonLogs, consoleTab]);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      addLog('error', 'Database connection offline. Configuration Required.');
      addLog('info', 'Please enter VITE_SUPABASE_URL & VITE_SUPABASE_ANON_KEY in your secrets settings.');
      return;
    }

    fetchAccounts();
    addLog('sys', 'Connected to CarX Street Backend Pipeline...');
    
    const channel = supabase
      .channel('realtime_accounts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, () => {
        fetchAccounts();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [displayedLogs]);

  function addLog(type: LogEntry['type'], message: string) {
    const now = new Date();
    const timestamp = now.toLocaleTimeString('en-GB', { hour12: false });
    setLogs(prev => [...prev, { timestamp, type, message, source: 'app', rawTime: now.getTime() }].slice(-50));
  }

  async function fetchAccounts() {
    const { data, error } = await supabase
      .from('accounts')
      .select('*')
      .order('updated_at', { ascending: false });

    if (!error && data) {
      setAccounts(data);
      calculateStats(data);
    }
  }

  function calculateStats(data: Account[]) {
    const total = data.length;
    const active = data.filter(a => a.status === 'active').length;
    const banned = data.filter(a => a.status === 'banned').length;
    const expired = data.filter(a => a.expiry_date && new Date(a.expiry_date) < new Date()).length;
    setStats({ total, active, banned, expired });
  }

  async function handleAddAccount(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    addLog('proc', `Initializing verification engine for ${username}...`);

    try {
      const res = await fetch('/api/accounts/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, days })
      });
      const data = await res.json();
      
      if (data.success) {
        addLog('success', `User '${username}' injected into Postgres schema.`);
        setUsername('');
        setPassword('');
      } else {
        addLog('error', `Failed: ${data.message}`);
      }
    } catch (error) {
      addLog('error', 'Critical connection failure during account injection.');
    } finally {
      setLoading(false);
    }
  }

  async function triggerUnban(user: string) {
    addLog('proc', `Initiating unban protocol for: ${user}...`);
    try {
      const res = await fetch('/api/accounts/unban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user })
      });
      const data = await res.json();
      
      if (data.success) {
        addLog('success', `Unban sequence complete for ${user}. Status: ACTIVE.`);
      } else {
        addLog('error', `Unban sequence aborted: ${data.message}`);
      }
    } catch (error) {
      addLog('error', 'Unban engine encountered a fatal execution error.');
    }
  }

  async function deleteAccount(email: string) {
    setAccountToDelete(email);
  }

  async function confirmDeleteAccount() {
    if (!accountToDelete) return;
    const email = accountToDelete;
    setAccountToDelete(null);
    
    const { error } = await supabase.from('accounts').delete().eq('email', email);
    if (error) {
      addLog('error', `Purge failed for ${email}.`);
    } else {
      addLog('sys', `Account ${email} purged from database.`);
      fetchAccounts();
    }
  }

  async function downloadProfile(email: string) {
    addLog('proc', `Requesting backup payload from Supabase Storage for ${email}...`);
    try {
      const res = await fetch(`/api/storage/download?email=${encodeURIComponent(email)}`);
      if (!res.ok) {
        throw new Error(`Server returned status code ${res.status}`);
      }
      const data = await res.json();
      const jsonStr = JSON.stringify(data, null, 2);
      
      // Save data to state to show the modal fallback instantly so the user can copy it
      setSelectedProfileJson(jsonStr);
      setSelectedProfileEmail(email);

      // Attempt standard browser download
      try {
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `${email.replace(/[@.]/g, '_')}_profile.json`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        addLog('success', `Backup download dispatched for ${email}`);
      } catch (downloadErr: any) {
        console.warn('Iframe download blocked, fallback modal activated:', downloadErr);
        addLog('info', 'File download may be restricted. Viewing backup data via modal instead.');
      }
    } catch (err: any) {
      addLog('error', `Download failed: ${err.message}`);
    }
  }

  async function handleBatchUnban() {
    const bannedAccounts = accounts.filter(acc => acc.status === 'banned');
    if (bannedAccounts.length === 0) {
      addLog('info', 'No banned accounts found to unban.');
      return;
    }
    addLog('proc', `Initiating batch unban sequence for ${bannedAccounts.length} accounts...`);
    for (const acc of bannedAccounts) {
      await triggerUnban(acc.email);
    }
    addLog('success', 'Batch unban operations complete.');
  }

  async function exportAllProfiles() {
    if (filteredAccounts.length === 0) {
      addLog('info', 'No profiles available to export.');
      return;
    }
    addLog('proc', `Batch exporting ${filteredAccounts.length} profiles from storage...`);
    for (const acc of filteredAccounts) {
      downloadProfile(acc.email);
    }
  }

  const filteredAccounts = accounts.filter(acc => 
    acc.email && acc.email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen lg:h-screen bg-brand-bg text-zinc-100 font-sans flex flex-col lg:overflow-hidden select-none">
      {/* Top Navigation */}
      <nav className="h-16 border-b border-brand-border flex items-center justify-between px-4 sm:px-8 bg-brand-surface shrink-0">
        <div className="flex items-center gap-3 sm:gap-4">
          <div className="w-8 h-8 bg-brand-accent rounded flex items-center justify-center font-black text-white italic text-sm">CX</div>
          <div className="h-4 w-px bg-brand-border"></div>
          <h1 className="text-sm sm:text-lg font-bold tracking-tight uppercase italic truncate">
            Car X Street <span className="text-brand-accent underline underline-offset-4 decoration-2">Panel</span>
          </h1>
        </div>
        <div className="flex items-center gap-2 sm:gap-6 text-[9px] sm:text-[10px] font-mono uppercase tracking-widest text-zinc-400">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]"></span>
            System Online
          </div>
          <div className="hidden sm:block text-zinc-600">|</div>
          <div className="hidden sm:block">v4.1.2</div>
          <div className="hidden md:block text-zinc-600">|</div>
          <div className="hidden md:block text-zinc-200">{new Date().toISOString().slice(0, 19).replace('T', ' ')}</div>
        </div>
      </nav>

      {/* Main Grid Layout */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-px bg-brand-border overflow-y-auto lg:overflow-hidden">
        
        {/* Left Column: Stats Sidebar */}
        <div className="col-span-1 lg:col-span-3 bg-brand-bg flex flex-col">
          <div className="p-4 sm:p-6 border-b border-zinc-900 flex flex-col gap-1">
            <label className="text-[10px] uppercase font-bold text-zinc-500 tracking-tighter">Admin Dashboard</label>
            <h2 className="text-lg sm:text-xl font-bold">Command Center</h2>
          </div>
          
          <div className="p-4 sm:p-6 grid grid-cols-3 lg:grid-cols-1 gap-3 sm:gap-4 lg:space-y-4">
            <StatBlock label="Total Accounts" value={stats.total.toLocaleString()} subValue="+0%" color="zinc" />
            <StatBlock label="Active Subs" value={stats.active.toLocaleString()} subValue={`${stats.total ? Math.round((stats.active/stats.total) * 100) : 0}%`} color="emerald" />
            <StatBlock label="Banned" value={stats.banned.toLocaleString()} subValue="Require" color="red" />
          </div>

          <div className="hidden lg:block mt-auto p-6 border-t border-zinc-900">
            <div className="p-4 bg-brand-accent/5 rounded-lg border border-brand-accent/20">
              <p className="text-xs text-orange-200/70 leading-relaxed italic">
                <strong className="text-brand-accent not-italic">PRO TIP:</strong> Use the batch unban tool to clear all detected Error 703 flags automatically.
              </p>
            </div>
          </div>
        </div>

        {/* Center Column: Actions & Form */}
        <div className="col-span-1 lg:col-span-5 bg-brand-surface flex flex-col border-y lg:border-y-0 lg:border-x border-brand-border">
          <div className="p-4 sm:p-6 flex flex-col flex-1 lg:overflow-y-auto">
            <div className="flex items-center justify-between mb-6 sm:mb-8">
              <h3 className="text-xs sm:text-sm font-bold uppercase tracking-widest text-zinc-400 italic">Add Account Connection</h3>
              <div className="px-2 py-0.5 sm:py-1 bg-zinc-800 rounded text-[8px] sm:text-[9px] font-mono text-zinc-500 uppercase">HTTPS / TLS 1.3</div>
            </div>
            
            <form onSubmit={handleAddAccount} className="space-y-4 sm:space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Game Login ID (Email)</label>
                <input 
                  type="email" 
                  placeholder="user@carx-street.com" 
                  className="w-full bg-black border border-brand-border p-3 sm:p-4 rounded text-xs sm:text-sm focus:outline-none focus:border-brand-accent transition-colors font-mono"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Access Password</label>
                <input 
                  type="password" 
                  placeholder="••••••••"
                  className="w-full bg-black border border-brand-border p-3 sm:p-4 rounded text-xs sm:text-sm focus:outline-none focus:border-brand-accent transition-colors font-mono"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Subscription Days</label>
                  <select 
                    className="w-full bg-black border border-brand-border p-3 sm:p-4 rounded text-xs sm:text-sm focus:outline-none focus:border-brand-accent font-mono"
                    value={days}
                    onChange={(e) => setDays(parseInt(e.target.value))}
                  >
                    <option value={30}>30 Days</option>
                    <option value={90}>90 Days</option>
                    <option value={365}>365 Days</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Sync Profile</label>
                  <div className="flex h-[46px] sm:h-[54px] bg-black border border-brand-border rounded items-center px-4 justify-between">
                    <span className="text-xs text-zinc-400">Auto-Restore Data</span>
                    <div className="w-8 h-4 bg-brand-accent rounded-full relative">
                      <div className="absolute right-1 top-1 w-2 h-2 bg-white rounded-full"></div>
                    </div>
                  </div>
                </div>
              </div>
              <button 
                type="submit"
                disabled={loading}
                className="w-full bg-brand-accent hover:bg-orange-500 text-white font-black py-3 sm:py-4 rounded uppercase tracking-tighter text-base sm:text-lg shadow-[0_0_20px_rgba(234,88,12,0.3)] transition-all disabled:opacity-50"
              >
                {loading ? 'Executing...' : 'Initialize Verification Engine'}
              </button>
            </form>

            <div className="mt-8 lg:mt-auto pt-6 lg:pt-12 space-y-4">
              <h4 className="text-[10px] font-bold text-zinc-600 uppercase tracking-widest border-b border-zinc-900 pb-2">Quick Commands</h4>
              <div className="grid grid-cols-2 gap-3">
                <button 
                  onClick={handleBatchUnban}
                  className="p-3 bg-zinc-900 border border-zinc-800 rounded text-xs font-bold hover:bg-zinc-800 transition flex items-center justify-center gap-2"
                >
                  <Zap className="w-3 h-3 text-brand-accent" /> Batch Unban
                </button>
                <button 
                  onClick={exportAllProfiles}
                  className="p-3 bg-zinc-900 border border-zinc-800 rounded text-xs font-bold hover:bg-zinc-800 transition flex items-center justify-center gap-2"
                >
                  <Download className="w-3 h-3 text-blue-500" /> Export JSON
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Accounts Table */}
        <div className="col-span-1 lg:col-span-4 bg-brand-bg flex flex-col max-h-[500px] lg:max-h-none lg:overflow-hidden border-t lg:border-t-0 border-brand-border">
          <div className="p-4 bg-zinc-900/30 border-b border-brand-border flex items-center justify-between shrink-0">
            <h3 className="text-xs font-black uppercase text-zinc-400 tracking-tighter">Recent Operations</h3>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-500" />
                <input 
                  type="text" 
                  placeholder="Filter..." 
                  className="bg-black border border-brand-border pl-7 pr-2 py-1 rounded text-[10px] focus:outline-none focus:border-brand-accent w-28 sm:w-32"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto min-h-[250px] lg:min-h-0 overflow-x-auto">
            <table className="w-full min-w-[340px] text-[11px] font-mono">
              <thead className="sticky top-0 bg-brand-bg z-10">
                <tr className="text-zinc-600 border-b border-zinc-900 text-left">
                  <th className="p-4 font-normal uppercase tracking-tight">Identifier</th>
                  <th className="p-4 font-normal uppercase tracking-tight">Status</th>
                  <th className="p-4 font-normal uppercase tracking-tight text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {filteredAccounts.map((acc) => (
                  <tr key={acc.email} className="hover:bg-white/5 group">
                    <td className="p-4 text-zinc-300 max-w-[140px] truncate">{acc.email}</td>
                    <td className={cn(
                       "p-4 font-bold",
                       acc.status === 'active' ? "text-emerald-500" : 
                       acc.status === 'banned' ? "text-red-500" : "text-zinc-500"
                    )}>
                      [{acc.status.toUpperCase()}]
                    </td>
                    <td className="p-2 sm:p-4 text-right">
                      <div className="flex items-center justify-end gap-2 text-zinc-400">
                        <button 
                          onClick={() => triggerUnban(acc.email)} 
                          className="p-2 hover:text-brand-accent hover:bg-zinc-900 rounded transition-colors" 
                          title="Unban Pipeline"
                        >
                          <Unlock className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => downloadProfile(acc.email)} 
                          className="p-2 hover:text-blue-400 hover:bg-zinc-900 rounded transition-colors" 
                          title="Download Profile Backup"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => deleteAccount(acc.email)} 
                          className="p-2 hover:text-red-400 hover:bg-zinc-900 rounded transition-colors" 
                          title="Delete Profile"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Bottom Console */}
      <footer className="h-52 lg:h-48 bg-black border-t border-brand-border p-3 sm:p-4 font-mono overflow-hidden flex flex-col shrink-0">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2 pb-1 border-b border-zinc-900/40">
          <div className="flex items-center gap-3">
            <div className="text-[10px] font-bold text-zinc-600 uppercase tracking-[0.3em] flex items-center gap-2">
              <Terminal className="w-3 h-3 text-brand-accent animate-pulse" /> System Real-Time Console Output
            </div>
            
            {/* Tab switchers */}
            <div className="flex items-center bg-zinc-950 border border-zinc-900 rounded p-0.5 ml-2">
              <button 
                onClick={() => setConsoleTab('all')}
                className={cn(
                  "px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider rounded transition-all",
                  consoleTab === 'all' ? "bg-zinc-900 text-brand-accent border border-zinc-800" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                Combined
              </button>
              <button 
                onClick={() => setConsoleTab('app')}
                className={cn(
                  "px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider rounded transition-all",
                  consoleTab === 'app' ? "bg-zinc-900 text-brand-accent border border-zinc-800" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                App Feed
              </button>
              <button 
                onClick={() => setConsoleTab('daemon')}
                className={cn(
                  "px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider rounded transition-all",
                  consoleTab === 'daemon' ? "bg-zinc-900 text-brand-accent border border-zinc-800" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                Backup Daemon
              </button>
            </div>

            <button 
              onClick={async () => {
                addLog('sys', 'Requesting manual daemon trigger...');
                try {
                  const res = await fetch('/api/daemon/run');
                  if (res.ok) addLog('success', 'Daemon cycle started remotely.');
                } catch (e) {
                  addLog('error', 'Failed to trigger daemon.');
                }
              }}
              className="ml-3 px-2 py-0.5 text-[8px] font-black uppercase bg-zinc-900 border border-zinc-800 text-zinc-500 hover:text-brand-accent hover:border-brand-accent/40 rounded transition-all flex items-center gap-1"
            >
              <RefreshCcw className="w-2 h-2" /> Force Run Daemon
            </button>
          </div>
          <div className="flex items-center gap-4 text-right">
             <div className="text-[9px] text-zinc-600 font-bold uppercase tracking-wider">
               Daemon status: <span className="text-emerald-500">● Live (30m Interval)</span>
             </div>
             <div className="text-[9px] text-zinc-700 font-mono">Accounts: {stats.total}</div>
          </div>
        </div>
        <div className="flex-1 bg-[#050505] p-3 rounded border border-zinc-900 text-[10px] leading-relaxed overflow-y-auto scrollbar-hide">
          {displayedLogs.length === 0 ? (
            <p className="text-zinc-700 italic py-2 text-center">[No console log payloads captured yet]</p>
          ) : (
            displayedLogs.map((log, i) => (
              <p key={i} className="text-zinc-600 flex items-start gap-1.5 py-0.5 font-mono">
                <span className="text-zinc-600/80 shrink-0 select-none">[{log.timestamp}]</span> 
                {renderLogMessage(log)}
              </p>
            ))
          )}
          <div ref={consoleEndRef} />
        </div>
      </footer>

      {/* Fallback Backup JSON Viewer Modal */}
      <AnimatePresence>
        {selectedProfileJson && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-brand-surface border border-brand-border rounded-lg max-w-2xl w-full flex flex-col max-h-[85vh] shadow-2xl overflow-hidden"
            >
              <div className="p-4 border-b border-brand-border flex items-center justify-between bg-zinc-900/50">
                <div>
                  <h3 className="text-sm font-bold text-zinc-200">Account Profile Backup Payload</h3>
                  <p className="text-[10px] text-zinc-500 font-mono mt-0.5">{selectedProfileEmail}</p>
                </div>
                <button 
                  onClick={() => setSelectedProfileJson(null)}
                  className="text-zinc-500 hover:text-zinc-200 text-sm font-mono px-2 py-1 rounded hover:bg-zinc-800 transition"
                >
                  [ESC] CLOSE
                </button>
              </div>
              
              <div className="p-4 flex-1 overflow-y-auto bg-black font-mono text-[10px] text-emerald-400 select-all border-b border-brand-border whitespace-pre-wrap leading-relaxed">
                {selectedProfileJson}
              </div>

              <div className="p-4 bg-zinc-900/30 flex items-center justify-between">
                <p className="text-[10px] text-zinc-500 italic">
                  * If your browser restricted the file download, copy the JSON block above.
                </p>
                <div className="flex gap-2">
                  <button 
                    onClick={() => {
                      navigator.clipboard.writeText(selectedProfileJson);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                      addLog('success', `Copied profile backup for ${selectedProfileEmail} to clipboard.`);
                    }}
                    className="px-4 py-2 bg-brand-accent hover:bg-orange-600 text-white font-black uppercase text-xs tracking-wider rounded transition-all flex items-center gap-1.5"
                  >
                    {copied ? 'Copied ✔' : 'Copy to Clipboard'}
                  </button>
                  <button 
                    onClick={() => setSelectedProfileJson(null)}
                    className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 font-bold uppercase text-xs rounded transition-all"
                  >
                    Close
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Custom Account Deletion Confirmation Modal */}
      <AnimatePresence>
        {accountToDelete && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-brand-surface border border-red-900/40 rounded-lg max-w-md w-full flex flex-col shadow-2xl overflow-hidden"
            >
              <div className="p-4 border-b border-brand-border flex items-center justify-between bg-zinc-900/50">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-500 animate-pulse" />
                  <h3 className="text-sm font-bold text-zinc-200">Purge Account Profile</h3>
                </div>
                <button 
                  onClick={() => setAccountToDelete(null)}
                  className="text-zinc-500 hover:text-zinc-200 text-xs font-mono px-2 py-1 rounded hover:bg-zinc-800 transition"
                >
                  CANCEL
                </button>
              </div>
              
              <div className="p-5 text-xs text-zinc-300 leading-relaxed bg-black border-b border-brand-border">
                <p className="mb-3 text-zinc-400">Are you sure you want to permanently delete this account profile from your database?</p>
                <div className="p-3 bg-zinc-900/50 rounded font-mono text-zinc-300 select-all border border-zinc-800 break-all">
                  {accountToDelete}
                </div>
                <p className="mt-3 text-red-500/70 text-[10px] italic">
                  * This action is irreversible. All cached tokens, profile configurations, and dynamic sync histories will be completely purged.
                </p>
              </div>

              <div className="p-4 bg-zinc-900/30 flex items-center justify-end gap-2">
                <button 
                  onClick={() => setAccountToDelete(null)}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 font-bold uppercase text-[10px] tracking-wider rounded transition-all"
                >
                  Cancel
                </button>
                <button 
                  onClick={confirmDeleteAccount}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-black uppercase text-[10px] tracking-wider rounded transition-all flex items-center gap-1.5"
                >
                  <Trash2 className="w-3 h-3" /> Purge Account
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatBlock({ label, value, subValue, color }: { label: string, value: string, subValue: string, color: string }) {
  const colorClasses: Record<string, string> = {
    zinc: "text-zinc-100",
    emerald: "text-emerald-400",
    red: "text-red-500"
  };

  return (
    <div className="p-3 sm:p-4 bg-zinc-900/50 border border-brand-border rounded-lg flex flex-col group hover:border-zinc-700 transition-colors justify-between w-full min-w-0">
      <span className="text-[9px] sm:text-[10px] text-zinc-500 uppercase font-black mb-1 truncate">{label}</span>
      <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-2">
        <span className={cn("text-xl sm:text-3xl font-mono font-bold tracking-tighter", colorClasses[color])}>{value}</span>
        <span className={cn("text-[9px] sm:text-[10px] uppercase font-bold truncate", color === 'red' ? "text-red-950 italic" : "text-zinc-500")}>{subValue}</span>
      </div>
    </div>
  );
}

function renderLogMessage(log: LogEntry) {
  const badge = log.source === 'daemon' ? (
    <span className="text-zinc-500 text-[8px] bg-zinc-900 border border-zinc-800 px-1 py-0.5 rounded mr-1.5 uppercase font-black">
      Daemon
    </span>
  ) : (
    <span className="text-brand-accent text-[8px] bg-zinc-950 border border-brand-accent/20 px-1 py-0.5 rounded mr-1.5 uppercase font-black">
      App
    </span>
  );

  let content;
  switch (log.type) {
    case 'sys': content = <><span className="text-blue-400 underline uppercase mr-1">SYS:AUTH</span> {log.message}</>; break;
    case 'proc': content = <><span className="text-brand-accent uppercase mr-1">PROC:</span> {log.message}</>; break;
    case 'success': content = <><span className="text-emerald-500 uppercase mr-1">SUCCESS:</span> {log.message}</>; break;
    case 'error': content = <><span className="text-red-500 animate-pulse font-bold uppercase mr-1">ALERT:</span> {log.message}</>; break;
    default: content = <><span className="text-zinc-400 uppercase mr-1">INFO:</span> {log.message}</>; break;
  }

  return (
    <div className="inline-flex items-center flex-wrap leading-relaxed py-0.5">
      {badge}
      {content}
    </div>
  );
}
