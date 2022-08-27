const path = require('path');
const express = require('express');
const request = require('request');
const basicAuth = require('express-basic-auth')
const helmet = require('helmet');
const https = require('https');
const fs = require('fs');

const PORT = process.env.PORT || 3001;
const PROTO_ENDPOINT = process.env.PROTO_ENDPOINT || 'http://localhost:5051/teku/v1/debug/beacon/protoarray';
const BASIC_USER = process.env.BASIC_PASS || 'password';
const BASIC_PASS = process.env.BASIC_PASS || 'password';
const HTTPS_KEY = process.env.HTTPS_KEY
const HTTPS_KEY_PASS = process.env.HTTPS_KEY_PASS
const HTTPS_CERT = process.env.HTTPS_CERT

const options = HTTPS_KEY ? {
  key: fs.readFileSync(HTTPS_KEY, 'utf8'),
  cert: fs.readFileSync(HTTPS_CERT, 'utf8'),
  passphrase: HTTPS_KEY_PASS
} : undefined


const app = express();

app.use(helmet())

app.disable('x-powered-by');

let users = {}
users[BASIC_USER] = BASIC_PASS
app.use(basicAuth({
  users: users
}))

// Have Node serve the files for our built React app
app.use(express.static(path.resolve(__dirname, '../build')));

// Handle GET requests to /api route
app.get("/data", (req, res) => {
  req.pipe(request(PROTO_ENDPOINT)).pipe(res);
});

// All other GET requests not handled before will return our React app
app.get('*', (req, res) => {
  res.sendFile(path.resolve(__dirname, '../build', 'index.html'));
});

// start server

app.listen(PORT, () => {
  console.log(`Example app listening on port ${PORT}`)
})

if (options) {
  https.createServer(options, app).listen(PORT + 1);
}