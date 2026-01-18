# NetSports Fantasy - NHL Playoff Pool

A production-ready fantasy hockey playoff pool application with live NHL stats integration.

## Features

- 🏒 **Per-Round Roster Selection** - Build a new team before each playoff round
- 📊 **Live NHL Stats** - Automatic updates from official NHL API
- 👥 **Groups** - Create pools with friends, group chat, blast messages
- 🏆 **Leaderboards** - Real-time standings with per-round breakdowns
- ⭐ **Star Players** - Designate 3 stars for 2x points
- 💰 **Salary Cap** - $30 budget resets each round
- 🔐 **User Authentication** - Secure JWT-based auth with email verification

## Tech Stack

- **Backend**: Node.js + Express.js
- **Database**: PostgreSQL
- **Frontend**: React (served by backend)
- **NHL Data**: Official NHL API (free)
- **Hosting**: Railway (recommended)

---

## 🚀 Railway Deployment Guide

Railway is a one-stop platform that hosts your backend, database, and frontend together.

### Prerequisites
- GitHub account
- Railway account ([railway.app](https://railway.app))

---

### Step 1: Prepare Your Repository

1. Create a new GitHub repository (e.g., `netsports-fantasy`)

2. Upload these files to your repo:
   ```
   netsports-fantasy/
   ├── public/
   │   └── index.html          # Frontend
   ├── src/
   │   ├── server.js
   │   ├── seed.js
   │   ├── routes/
   │   ├── services/
   │   ├── middleware/
   │   └── jobs/
   ├── config/
   │   └── database.js
   ├── migrations/
   │   └── 001_initial_schema.sql
   ├── package.json
   ├── .gitignore
   └── README.md
   ```

3. Create a `.gitignore` file:
   ```
   node_modules/
   .env
   .DS_Store
   ```

4. Push to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/netsports-fantasy.git
   git push -u origin main
   ```

---

### Step 2: Create Railway Project

1. Go to [railway.app](https://railway.app) and sign in with GitHub

2. Click **"New Project"**

3. Select **"Deploy from GitHub repo"**

4. Choose your `netsports-fantasy` repository

5. Railway will detect it's a Node.js app and start deploying

---

### Step 3: Add PostgreSQL Database

1. In your Railway project, click **"New"** (+ button)

2. Select **"Database"** → **"Add PostgreSQL"**

3. Railway automatically creates `DATABASE_URL` environment variable

4. Click on the PostgreSQL service to see connection details

---

### Step 4: Configure Environment Variables

1. Click on your **web service** (the Node.js app)

2. Go to **"Variables"** tab

3. Add these variables:

| Variable | Value | Description |
|----------|-------|-------------|
| `JWT_SECRET` | `your-super-secret-random-string-here` | Use a long random string (32+ chars) |
| `NODE_ENV` | `production` | Enables production mode |
| `ADMIN_EMAIL` | `your@email.com` | Your admin account email |
| `NHL_SEASON` | `20252026` | Current NHL season |
| `EMAIL_HOST` | `smtp.gmail.com` | SMTP server host (e.g., Gmail, SendGrid) |
| `EMAIL_PORT` | `587` | SMTP port (587 for TLS, 465 for SSL) |
| `EMAIL_USER` | `your-email@gmail.com` | Email account username |
| `EMAIL_PASSWORD` | `your-app-password` | Email account password or app-specific password |
| `EMAIL_FROM` | `NetSports Fantasy <noreply@yourdomain.com>` | From address (optional, defaults to EMAIL_USER) |
| `EMAIL_SECURE` | `false` | Use SSL (true for port 465, false for 587) |

**Note:** `DATABASE_URL` and `PORT` are automatically set by Railway.

---

### Step 5: Run Database Migrations

1. In Railway, click on your **web service**

2. Go to **"Settings"** tab

3. Find **"Railway Shell"** or use the **"Deploy"** tab's shell

4. Run these commands:

```bash
# Run the database schema migration
npm run migrate

# Seed initial data (teams and players)
npm run seed

# Fetch initial NHL stats
npm run fetch-stats
```

**Alternative:** Use Railway CLI locally:
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Link to your project
railway link

# Run commands
railway run npm run migrate
railway run npm run seed
```

---

### Step 6: Deploy and Test

1. Railway auto-deploys when you push to GitHub

2. Click **"Settings"** → **"Domains"** → **"Generate Domain"**

3. You'll get a URL like: `https://netsports-fantasy-production.up.railway.app`

4. Visit your URL - the app should be live!

---

### Step 7: Create Your Admin Account

1. Visit your deployed app

2. Click **"Sign Up"**

3. Register with the email you set as `ADMIN_EMAIL`

4. Check your email for the 6-digit verification code

5. Enter the code to verify your account
   - **Didn't receive the email?** Use the "Resend Code" option to request a new verification email
   - Check your spam folder if you don't see the email

6. Once verified, you'll have admin access to:
   - Change current playoff round
   - Trigger manual stat refreshes

---

## 📁 Project Structure

```
netsports-fantasy/
├── public/
│   └── index.html              # React frontend (served by Express)
├── src/
│   ├── server.js               # Express server entry point
│   ├── seed.js                 # Database seeding script
│   ├── routes/
│   │   ├── auth.js             # Authentication endpoints
│   │   ├── players.js          # Player data endpoints
│   │   ├── rosters.js          # Roster management
│   │   ├── groups.js           # Groups and chat
│   │   └── standings.js        # Leaderboards
│   ├── services/
│   │   └── nhlApi.js           # NHL API integration
│   ├── middleware/
│   │   └── auth.js             # JWT authentication
│   └── jobs/
│       └── fetchStats.js       # Scheduled stat updates
├── config/
│   └── database.js             # PostgreSQL connection
├── migrations/
│   └── 001_initial_schema.sql  # Database schema
├── package.json
└── README.md
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string (auto-set by Railway) |
| `JWT_SECRET` | Yes | Secret key for JWT tokens |
| `EMAIL_HOST` | Yes | SMTP server host (e.g., `smtp.gmail.com`, `smtp.sendgrid.net`) |
| `EMAIL_USER` | Yes | Email account username |
| `EMAIL_PASSWORD` | Yes | Email account password or app-specific password |
| `PORT` | No | Server port (default: 3001, auto-set by Railway) |
| `NODE_ENV` | No | `development` or `production` |
| `ADMIN_EMAIL` | No | Email for admin account |
| `NHL_SEASON` | No | NHL season (e.g., `20252026`) |
| `EMAIL_PORT` | No | SMTP port (default: 587 for TLS) |
| `EMAIL_FROM` | No | From address (defaults to EMAIL_USER) |
| `EMAIL_SECURE` | No | Use SSL (true for port 465, false for 587) |
| `FRONTEND_URL` | No | For CORS (not needed when serving frontend from same origin) |

### Email Configuration

The app requires email configuration to send verification codes. Here are settings for common providers:

**Gmail:**
```
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_SECURE=false
```
Note: You must use an [App Password](https://support.google.com/accounts/answer/185833), not your regular Gmail password.

**SendGrid:**
```
EMAIL_HOST=smtp.sendgrid.net
EMAIL_PORT=587
EMAIL_USER=apikey
EMAIL_PASSWORD=your-sendgrid-api-key
EMAIL_SECURE=false
```

**Outlook/Office 365:**
```
EMAIL_HOST=smtp-mail.outlook.com
EMAIL_PORT=587
EMAIL_USER=your-email@outlook.com
EMAIL_PASSWORD=your-password
EMAIL_SECURE=false
```

### Lock Dates

Edit the `settings` table in the database or use the migration to set playoff round lock dates:

```sql
UPDATE settings 
SET value = '{"1": "2026-04-19T19:00:00-04:00", "2": "2026-05-03T19:00:00-04:00", "3": "2026-05-17T19:00:00-04:00"}'
WHERE key = 'lock_dates';
```

---

## 📊 NHL Stats Updates

Stats are automatically fetched from the NHL API:

### Automatic Schedule (Production)
- **Every 15 minutes** during game hours (6 PM - 1 AM ET)
- **2 AM ET** - Overnight final update
- **12 PM ET** - Verified daytime update

### Manual Update
- Admin can trigger refresh from the admin panel
- Or run: `npm run fetch-stats`

---

## 🔧 Local Development

```bash
# Clone repo
git clone https://github.com/YOUR_USERNAME/netsports-fantasy.git
cd netsports-fantasy

# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your local PostgreSQL credentials

# Run migrations
npm run migrate

# Seed data
npm run seed

# Start development server
npm run dev

# Visit http://localhost:3001
```

---

## 📝 API Endpoints

### Authentication
- `POST /api/auth/register` - Create account
- `POST /api/auth/verify` - Verify email with code
- `POST /api/auth/resend-verification` - Resend verification code email
- `POST /api/auth/login` - Login
- `GET /api/auth/me` - Get current user

### Players
- `GET /api/players` - Get all players with stats

### Rosters
- `GET /api/rosters` - Get user's rosters
- `PUT /api/rosters/:round` - Save roster
- `POST /api/rosters/:round/submit` - Submit roster

### Standings
- `GET /api/standings` - Global leaderboard
- `GET /api/standings/settings` - Current round, lock dates
- `POST /api/standings/refresh` - Trigger stat update (admin)

### Groups
- `GET /api/groups` - User's groups
- `POST /api/groups` - Create group
- `POST /api/groups/join` - Join by code
- `GET /api/groups/:id` - Group details with chat
- `POST /api/groups/:id/chat` - Send message

---

## 🔒 Security Features

- **Password Hashing** - bcrypt with salt rounds
- **JWT Authentication** - Secure token-based auth
- **Rate Limiting** - Prevents brute force attacks and email spam
  - General API: 100 requests per 15 minutes
  - Auth endpoints: 10 attempts per hour
  - Resend verification: 3 attempts per hour (prevents email spam)
- **Input Validation** - Server-side validation
- **CORS Protection** - Configured for your domain
- **Email Verification** - Required before account activation

---

## 💰 Estimated Costs

### Railway Pricing
- **Hobby Plan**: ~$5-10/month total
  - Backend: ~$2-5/month (usage-based)
  - PostgreSQL: ~$2-5/month (storage-based)
- **Free Trial**: $5 credit to start

---

## 🆘 Troubleshooting

### "Database connection error"
- Check `DATABASE_URL` is set correctly
- Ensure PostgreSQL service is running in Railway

### "Invalid token" errors
- Make sure `JWT_SECRET` is set
- Clear browser localStorage and login again

### Email verification not received
- Check your spam/junk folder
- Verify email configuration variables are set correctly (`EMAIL_HOST`, `EMAIL_USER`, `EMAIL_PASSWORD`)
- Use the "Resend Code" feature to request a new verification email
- Check Railway logs for email sending errors
- For Gmail, ensure you're using an App Password, not your regular password

### Stats not updating
- Check the `stat_update_log` table for errors
- Verify NHL API is accessible: `curl https://api-web.nhle.com/v1/schedule/now`

### CORS errors in development
- Set `FRONTEND_URL=http://localhost:3000` in .env

---

## 📄 License

MIT License - feel free to use for your own playoff pools!

---

## 🙏 Credits

- NHL API (unofficial, free)
- Built with Express.js, React, PostgreSQL
- Deployed on Railway
