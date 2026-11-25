-- Coastal Links 3D — Optional Supabase Leaderboard Schema
create table if not exists public.coastal_leaderboard (
  id uuid primary key default gen_random_uuid(),
  player_name text not null check (char_length(player_name) between 1 and 32),
  difficulty text not null check (difficulty in ('amateur', 'pro', 'tour')),
  total_score integer not null check (total_score between 18 and 180),
  to_par integer not null,
  fairways_pct integer not null default 0,
  gir_pct integer not null default 0,
  putts integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists coastal_leaderboard_rank_idx
  on public.coastal_leaderboard (difficulty, to_par asc, putts asc);

alter table public.coastal_leaderboard enable row level security;

create policy "Anyone can read coastal leaderboard"
  on public.coastal_leaderboard for select
  using (true);

create policy "Anyone can submit round score"
  on public.coastal_leaderboard for insert
  with check (true);
