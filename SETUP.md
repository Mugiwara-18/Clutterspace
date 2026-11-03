# Clutterspace: setup (all free, ~15 minutes)

## 1. Deploy the site (free)
1. Go to https://app.netlify.com/drop.
2. Drag the whole `idea-library` folder onto the page. You get a URL like `https://something.netlify.app`.
   The folder includes `netlify/functions/meta.js`, a free serverless function that reads a reel's caption and thumbnail so titles and collections fill in automatically. If Netlify Drop ignores the function (the app then shows titles like "Instagram reel · abc123" and files everything in Inbox), put the folder in a free GitHub repo and use *Add new site → Import from Git* instead. Functions are picked up automatically that way.
3. Open that URL **in Chrome on your Android phone**, tap the menu (⋮) → **Install app / Add to Home screen**.
4. Now when you tap **Share** on any reel in Instagram, "Library" shows up in the share sheet. That's it: it saves instantly, then fills in the title, thumbnail and collection a few seconds later. Tap **Edit** on the banner or any card to change anything.

At this point it already works, but saves only inside that browser. For phone + laptop sync, do step 2.

## 2. Turn on sync (free Supabase project)
1. Create a free project at https://supabase.com (no card needed).
2. Open **SQL Editor** and run:

```sql
create table public.items (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,
  title text,
  note text,
  description text,
  image text,
  auto boolean default true,
  manual boolean default false,
  collection text default 'Inbox',
  tags text[] default '{}',
  starred boolean default false,
  seen boolean default false,
  created_at timestamptz default now()
);
alter table public.items enable row level security;
create policy "own rows select" on public.items for select using (auth.uid() = user_id);
create policy "own rows insert" on public.items for insert with check (auth.uid() = user_id);
create policy "own rows update" on public.items for update using (auth.uid() = user_id);
create policy "own rows delete" on public.items for delete using (auth.uid() = user_id);
```

3. **Project Settings → API**: copy the *Project URL* and the *anon public* key into `config.js`.
4. **Authentication → Sign In / Providers → Email**: make sure Email is enabled and switch **Confirm email** OFF (so you can sign in right after creating the account, no email needed).
5. Re-deploy (drag the folder onto Netlify again). In the app: ⋯ menu → **Sync across devices** → enter your email + a password → **Create account**. On your other device, open the app, use the same menu and just **Sign in** with the same email and password.

The anon key is safe to publish; row-level security means each signed-in user can only see their own rows.

## 3. Turn on Gemini auto-titles & sorting (free)
1. Go to https://aistudio.google.com/apikey, sign in and click **Create API key**. Copy it.
2. In Netlify: your site → **Site configuration → Environment variables → Add a variable**.
   Key: `GEMINI_API_KEY`  Value: the key you copied. (Optional: `GEMINI_MODEL` to pick a different model; the default is `gemini-3.5-flash-lite`.)
3. **Redeploy** (drag the folder again, or Deploys → Trigger deploy). Env variables only apply to new deploys.
4. Open the app → ⋯ → **Re-sort & refill details**. Existing saves get new titles and collections.
The key stays on Netlify's server; it is never in the app code.

## 4. Thumbnails that last (Supabase, 1 minute)
Instagram image links expire after a few days, so the app saves a copy of each thumbnail in Supabase Storage. Run this once in Supabase → SQL Editor:

```sql
insert into storage.buckets (id, name, public) values ('thumbs', 'thumbs', true) on conflict (id) do nothing;
create policy "thumbs select own" on storage.objects for select to authenticated
  using (bucket_id = 'thumbs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "thumbs insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'thumbs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "thumbs update own" on storage.objects for update to authenticated
  using (bucket_id = 'thumbs' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "thumbs delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'thumbs' and (storage.foldername(name))[1] = auth.uid()::text);
```

## Notes
- Auto-fill reads the reel's public caption. Instagram sometimes hides it from servers; when that happens the card gets a simple title and lands in Inbox, and you can edit it or use ⋯ → *Re-sort & refill details* later.
- Titles you type yourself, and collections you pick or drag to, are never overwritten by the auto-sorter.
- Use ⋯ → **Export backup** now and then. The free tier is generous, but keep a copy.
