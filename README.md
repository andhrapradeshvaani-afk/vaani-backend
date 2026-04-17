# AP Grievance Portal — Backend API

A civic grievance management platform for Andhra Pradesh citizens.
Built with Node.js, Express, PostgreSQL (Supabase), Cloudinary, and Twilio.

---

## Quick Start (Step by Step)

### Step 1 — Install Node.js
Download from https://nodejs.org (choose LTS version)

### Step 2 — Set up Supabase (free database)
1. Go to https://supabase.com and create a free account
2. Create a new project (choose any region, set a strong password)
3. Go to SQL Editor → paste the entire contents of `database/schema.sql` → Run
4. Go to Settings → Database → copy the "Connection string (URI)"
5. Paste it as DATABASE_URL in your .env file

### Step 3 — Set up Cloudinary (free photo storage)
1. Go to https://cloudinary.com and create a free account
2. From Dashboard, copy Cloud Name, API Key, API Secret
3. Paste into your .env file

### Step 4 — Set up Twilio (free SMS trial)
1. Go to https://twilio.com and create a free account
2. Verify your phone number
3. From Console, copy Account SID, Auth Token, and your Twilio phone number
4. Paste into your .env file

### Step 5 — Configure environment
```bash
cp .env.example .env
# Now edit .env with your actual values
```

### Step 6 — Install dependencies and run
```bash
npm install
npm run dev
```

API will be running at http://localhost:3001

---

## API Endpoints

### Public (no login required)
| Method | URL | Description |
|--------|-----|-------------|
| GET | /api/districts | List all AP districts |
| GET | /api/districts/:id/mandals | List mandals for a district |
| GET | /api/departments | List all departments |
| GET | /api/complaints/track/:complaintNo | Track complaint by ID |
| GET | /api/dashboard/public | Public stats dashboard |

### Citizen (requires login token)
| Method | URL | Description |
|--------|-----|-------------|
| POST | /api/citizens/register | Register new citizen |
| POST | /api/citizens/login | Login with phone |
| POST | /api/complaints | File a new complaint |
| GET | /api/complaints/mine | Get my complaints |

### Officer (requires officer token)
| Method | URL | Description |
|--------|-----|-------------|
| POST | /api/officers/login | Officer login |
| GET | /api/officer/complaints | List complaints (with filters) |
| PATCH | /api/officer/complaints/:id/status | Update complaint status |
| GET | /api/officer/dashboard | Officer dashboard stats |

---

## File a Complaint (example)

```bash
# 1. Register as citizen
curl -X POST http://localhost:3001/api/citizens/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Ravi Kumar","phone":"9876543210","district_id":1}'

# 2. Use the token from registration to file a complaint
curl -X POST http://localhost:3001/api/complaints \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "department_id=1" \
  -F "district_id=1" \
  -F "title=Pothole on main road near bus stand" \
  -F "description=Large pothole causing accidents near Tirupati bus stand" \
  -F "priority=urgent"

# 3. Track complaint (no login needed)
curl http://localhost:3001/api/complaints/track/AP-2025-CTR-00001
```

---

## Deploy to Render.com (free hosting)

1. Push your code to GitHub
2. Go to https://render.com → New Web Service
3. Connect your GitHub repo
4. Set build command: `npm install`
5. Set start command: `node server.js`
6. Add all environment variables from your .env file
7. Deploy — your API will be live at https://your-app.onrender.com

---

## Project Structure

```
ap-grievance/
├── server.js          ← Main API server (all routes)
├── package.json       ← Dependencies
├── .env.example       ← Environment variable template
├── .gitignore         ← Tells git to ignore .env and node_modules
└── database/
    └── schema.sql     ← Complete PostgreSQL schema
```

---

## What's Next

After the backend is running, build:
1. **Web frontend** — Next.js complaint form + tracking page
2. **Mobile app** — React Native with Expo
3. **Admin dashboard** — React app for government officers

---

## Security Notes

- Aadhaar numbers are NEVER stored raw — only SHA-256 hashed
- JWT tokens expire in 30 days (citizens) / 12 hours (officers)
- All DB queries use parameterized inputs (prevents SQL injection)
- CORS is enabled — restrict to your domain in production

---

Built for Andhra Pradesh citizens. Open source.
