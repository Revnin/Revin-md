# Revin-MD pairing page

This is a static public page for Replit. Upload the `pairing` folder as a static app.

Before publishing, replace `https://YOUR-BACKEND.example.com` in `index.html` with the persistent backend URL. The backend must expose `POST /api/pair`, return JSON such as `{ "code": "ABCD1234" }`, and allow CORS from the Replit domain.
