// Run locally or on a normal server:  npm start
const app = require('./src/app');
const PORT = process.env.PORT || 3000;
app.connectDB()
  .then(() => app.listen(PORT, () => console.log(`NBYM running on http://localhost:${PORT}`)))
  .catch((e) => { console.error('MongoDB connection failed:', e.message); process.exit(1); });
