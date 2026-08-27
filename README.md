# fazilportfolio

Static portfolio with **Firestore** (projects), **Cloudinary** (videos), **Firebase Auth** (admin), and **Firebase Hosting** (deploy).

## Folder structure

```
fazilportfolio/
├── public/                 # Site files (Firebase Hosting root)
│   ├── index.html
│   ├── admin.html
│   ├── roles.html
│   ├── cinematographer.html
│   ├── editor.html
│   ├── director.html
│   ├── assets/             # Images / media
│   └── js/                 # App scripts
│       ├── firebase-config.js
│       ├── portfolio-core.js
│       ├── portfolio-render.js
│       └── projects-data.js
├── firebase/               # Firestore rules & indexes
│   ├── firestore.rules
│   └── firestore.indexes.json
├── firebase.json
├── .firebaserc
├── server.py               # Local server
├── .env                    # Secrets (not committed)
└── README.md
```

## Local run

```bash
python3 server.py
```

Open http://127.0.0.1:3001 (or the `PORT` in `.env`).

Admin: http://127.0.0.1:3001/admin.html — sign in with **Firebase Auth** email/password.

## Firebase setup

1. Create a project at [Firebase Console](https://console.firebase.google.com)
2. Enable **Authentication → Email/Password** and create an admin user
3. Create **Firestore** (then deploy rules)
4. Put web config in [`public/js/firebase-config.js`](public/js/firebase-config.js)
5. Set project ID in [`.firebaserc`](.firebaserc)

```bash
npm install -g firebase-tools
firebase login
firebase deploy
```

## Cloudinary unsigned uploads

1. Create an **unsigned** upload preset (folder `fazil-portfolio`)
2. Set `cloudName` + `uploadPreset` in `public/js/firebase-config.js`

## Notes

- Do not commit `.env`
- Hosting serves the `public/` folder only
- Firestore rules live in `firebase/firestore.rules`
