const express = require('express');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'templates')));

// route principale
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates', 'page_canto.html'));
});

app.listen(3000, () => {
  console.log('Serveur lancé sur http://localhost:3000');
});