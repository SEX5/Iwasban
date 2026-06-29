export interface Account {
  email: string;
  password?: string;
  last_token?: string;
  profile_data?: any;
  expiry_date?: string;
  status: 'active' | 'banned' | 'expired' | string;
  last_sync?: string;
  money?: number;
  cars_count?: number;
  nickname?: string;
  gold?: number;
  user_id?: string;
  updated_at: string;
}

export interface Stats {
  total: number;
  active: number;
  banned: number;
  expired: number;
}

