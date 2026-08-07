const { CryptoProvider } = require('@azure/msal-node');
const cryptoProvider = new CryptoProvider();
// require('dotenv').config();
const express = require('express');
const nunjucks = require('nunjucks');
const path = require('path');
const { Pool } = require('pg');
const flash = require('connect-flash');
const { BlobServiceClient } = require('@azure/storage-blob');
const appInsights = require('applicationinsights');
const gm = require('gm').subClass({ imageMagick: true });
const fs = require('fs');
const os = require('os');
const { pipeline } = require('stream/promises');

let insightsClient;
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    appInsights.setup()
        .setAutoDependencyCorrelation(true)
        .setAutoCollectRequests(true)
        .setAutoCollectPerformance(true, true)
        .setAutoCollectExceptions(true)
        .setAutoCollectDependencies(true)
        .setAutoCollectConsole(true)
        .setUseDiskRetryCaching(true)
        .start();
    insightsClient = appInsights.defaultClient;
    console.log("Application Insights : ACTIVÉ (Mode Cloud)");
} 
else {
    insightsClient = {
        trackEvent: (data) => console.log(`[Local Analytics] Événement simulé : ${data.name}`)
    };
    console.log("Application Insights : DÉSACTIVÉ (Mode Local - Événements simulés dans la console)");
}

const app = express();

// Custom performance middleware to measure and log page load times
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        // If it's a key page load (like /index, /stats, /portal, /upload, etc.) log it!
        if (req.method === 'GET' && (req.path === '/index' || req.path === '/stats' || req.path.startsWith('/portal'))) {
            const user = req.session?.user_email || req.session?.portal_user_email || "Visiteur";
            
            if (insightsClient) {
                insightsClient.trackEvent({
                    name: "page_load",
                    properties: {
                        path: req.path,
                        duration_ms: duration,
                        utilisateur: user
                    }
                });
            }
        }
    });
    next();
});

const morgan = require('morgan');

if (process.env.NODE_ENV === 'production') {
    app.use(morgan('combined')); 
} 
else {
    app.use(morgan('dev')); 
}

const PORT = process.env.PORT || 3000;
const pool = new Pool({
    user: process.env.POSTGRES_USER,
    host: process.env.POSTGRES_HOST,
    database: process.env.POSTGRES_DB,
    password: process.env.POSTGRES_PASSWORD,
    port: process.env.POSTGRES_PORT || 5432,
    ssl: { rejectUnauthorized: false },
    max: 30, 
    idleTimeoutMillis: 30000, 
});

// Create the activity logs table automatically on startup
pool.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        event_name VARCHAR(100) NOT NULL,
        username VARCHAR(100),
        properties JSONB DEFAULT '{}'::jsonb,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`).catch(err => console.error("Failed to create activity_logs table:", err));

// wrapper to automatically intercept and save all appinsight events to the database
const originalTrackEvent = insightsClient && insightsClient.trackEvent;
insightsClient = {
    trackEvent: function(telemetry) {
        if (originalTrackEvent) {
            try { originalTrackEvent(telemetry); } catch (e) {}
        } else {
            console.log(`[Local Analytics] Event: ${telemetry.name}`, telemetry.properties);
        }

        const properties = telemetry.properties || {};
        const username = properties.utilisateur || properties.user || properties.admin || "Visiteur";

        pool.query(`
            INSERT INTO activity_logs (event_name, username, properties)
            VALUES ($1, $2, $3);
        `, [telemetry.name, username, JSON.stringify(properties)])
        .catch(err => console.error("Failed to save activity log to DB:", err.message));
    }
};

const multer = require('multer');
const sanitize = require('sanitize-filename');
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient(process.env.AZURE_STORAGE_CONTAINER);
const AzureStreamStorage = {
    _handleFile: async function (req, file, cb) {
        try {
            const correctName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            const filename = sanitize(correctName).replace(/\s+/g, '_');
            const checkExist = await pool.query("SELECT id FROM documents WHERE nom_fichier = $1 LIMIT 1;", [filename]);
            
            if (checkExist.rows.length > 0) {
                return cb(new Error(`FileExists_Error:${filename}`));
            }

            const blockBlobClient = containerClient.getBlockBlobClient(filename);
            const bufferSize = 4 * 1024 * 1024; 
            const maxBuffers = 20;

            const MIME_OVERRIDES = {
                '.jfif': 'image/jpeg',
                '.jpe':  'image/jpeg',
                '.tif':  'image/tiff',
                '.tiff': 'image/tiff',
                '.bmp':  'image/bmp',
                '.avif': 'image/avif',
                '.heif': 'image/heif',
                '.dng':  'image/x-adobe-dng',
                '.cr2':  'image/x-canon-cr2',
                '.nef':  'image/x-nikon-nef',
                '.arw':  'image/x-sony-arw',
                '.srt':  'text/plain',
            };
            const fileExt = path.extname(file.originalname).toLowerCase();
            const correctedMime = MIME_OVERRIDES[fileExt] || file.mimetype;

            await blockBlobClient.uploadStream(file.stream, bufferSize, maxBuffers, {
                blobHTTPHeaders: { 
                    blobContentType: correctedMime,
                    blobContentDisposition: 'inline' 
                }
            });
            
            const properties = await blockBlobClient.getProperties();

            cb(null, {
                originalname: correctName, 
                filename: filename,
                url: blockBlobClient.url,
                size: properties.contentLength
            });
        } catch (error) {
            console.error("Erreur de Stream Azure :", error);
            cb(error);
        }
    },
    _removeFile: function (req, file, cb) { cb(null); }
};

// eviter certains extension
const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const forbidden_extensions = [];
    
    if (forbidden_extensions.includes(ext)) {
        return cb(new Error(`Extension_Error:${ext}`));
    }
    cb(null, true);
};

const uploadStream = multer({ storage: AzureStreamStorage, fileFilter: fileFilter });
const upload = multer();

const bcrypt = require('bcryptjs');
const msal = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');
const crypto = require('crypto');

const msalConfig = {
    auth: {
        clientId: process.env.AZURE_AD_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}`,
        clientSecret: process.env.AZURE_AD_CLIENT_SECRET

    }
};
const cca = new msal.ConfidentialClientApplication(msalConfig);

const env = nunjucks.configure('templates', {
    autoescape: true,
    express: app,
    watch: true 
});

const session = require('express-session');

const rateLimit = require('express-rate-limit');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1); // a mettre en prod avec secure : true
app.use(session({
    secret: process.env.SECRET_KEY || 'super_secret_key_de_secours',
    resave: false,
    saveUninitialized: false,
    name: 'portal_session',
    rolling: true,
    cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// bouclier anti-brute force pour les connexions
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 5, 
    message: "Too many login attempts. Please wait 15 minutes before trying again.",
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        if (req.path.includes('/login')) {
            const portal_id = req.params.portal_id;
            if (portal_id) {
                return res.status(options.statusCode).render('portal_login.html', { 
                    portal_id: portal_id, 
                    portal_name: "Portal", 
                    error: options.message 
                });
            }
        }
        res.status(options.statusCode).send(options.message);
    }
});

app.use(flash());

app.use((req, res, next) => {
    res.locals.session = {
        get: function(key) { return req.session ? req.session[key] : null; }
    };    
    res.locals.get_flashed_messages = function(withCategories = false) {
        const flashes = req.flash();
        const messages = [];
        for (const category in flashes) {
            for (const msg of flashes[category]) {
                if (withCategories) {
                    messages.push([category === 'error' ? 'danger' : category, msg]);
                } 
                else {
                    messages.push(msg);
                }
            }
        }
        return messages;
    };
    next();
});


const authMsalConfig = {
    auth: {
        clientId: process.env.AZURE_AD_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}`
    }
};
const pca = new msal.PublicClientApplication(authMsalConfig);

env.addGlobal('url_for', function(type, kwargs) {
    if (type === 'static') {
        return '/static/' + kwargs.filename;
    }
    return '/'; 
});

env.addGlobal('session', {
    get: function(key, req) {
        return ""; 
    }
});

env.addFilter('max', function(array) {
    if (!array || array.length === 0) return 0;
    return Math.max(...array);
});

env.addFilter('min', function(array) {
    if (!array || array.length === 0) return 0;
    return Math.min(...array);
});

env.addFilter('date', function(dateObj) {
    if (!dateObj) return "";
    const d = new Date(dateObj);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
});

async function sendEmail(toEmail, subject, body) {
    try {
        const tokenResponse = await cca.acquireTokenByClientCredential({
            scopes: ["https://graph.microsoft.com/.default"],
        });
        const client = Client.init({
            authProvider: (done) => done(null, tokenResponse.accessToken),
        });
        const sendMail = {
            message: {
                subject: subject,
                body: { contentType: 'Text', content: body },
                toRecipients: [{ emailAddress: { address: toEmail } }],
                from: { emailAddress: { address: process.env.SMTP_USERNAME, name: "Media Library" } }
            },
            saveToSentItems: "true"
        };

        await client.api(`/users/${process.env.SMTP_USERNAME}/sendMail`).post(sendMail);
        return true;
    } catch (error) {
        console.error("Erreur Graph API:", error);
        return false;
    }
}

async function checkPortalAccess(email, portalId, password = null) {
    const res = await pool.query(
        "SELECT id, password FROM portal_users WHERE LOWER(email) = LOWER($1) AND portal_id = $2;",
        [email, portalId]
    );
    if (res.rows.length === 0) return false;
    if (password) {
        return await bcrypt.compare(password, res.rows[0].password);
    }
    return true;
}

// recup uniquement le dossier root et ses descendants — jamais les parents/frères
async function getFolderSubtree(rootFolderId) {
    if (!rootFolderId) return [];
    const result = await pool.query(`
        WITH RECURSIVE folder_tree AS (
            SELECT id, name, parent_id, creation_date, 0 AS depth
            FROM folders
            WHERE id = $1

            UNION ALL

            SELECT f.id, f.name, f.parent_id, f.creation_date, ft.depth + 1
            FROM folders f
            INNER JOIN folder_tree ft ON f.parent_id = ft.id
        )
        SELECT * FROM folder_tree ORDER BY depth, name;
    `, [rootFolderId]);
    return result.rows;
}

app.get('/portal/:portal_id/tree', loginRequiredHtml, async (req, res) => {
    try {
        const identifier = req.params.portal_id;
        const portalRes = await pool.query("SELECT * FROM portals WHERE id::text = $1 OR slug = $1;", [identifier]);
        if (portalRes.rows.length === 0) return res.status(404).json({ status: "error" });
        const portalRow = portalRes.rows[0];
        const isGlobalAuth = !!req.session.user_email;
        const isAuthorizedPortalUser = !!req.session.portal_user_email && (req.session.portal_access == portalRow.id);
        if (!isGlobalAuth && !isAuthorizedPortalUser) return res.status(403).json({ status: "error" });
        if (!portalRow.root_folder_id) {
            return res.json({ status: "success", tree: [], root_id: null });
        }
        const flatTree = await getFolderSubtree(portalRow.root_folder_id);
        const map = {};
        flatTree.forEach(f => map[f.id] = { ...f, subfolders: [] });
        flatTree.forEach(f => {
            if (f.parent_id && map[f.parent_id]) map[f.parent_id].subfolders.push(map[f.id]);
        });

        res.json({ status: "success", tree: map[portalRow.root_folder_id] || null, root_id: portalRow.root_folder_id });
    } catch (error) {
        console.error("Erreur /portal/:portal_id/tree:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.use('/static', express.static(path.join(__dirname, 'static')));


app.get('/', loginRequiredHtml, (req, res) => {
    res.redirect('/index');
});

async function generateAndUploadThumbnail(filename, containerClient, pool) {
    const ext = path.extname(filename).toLowerCase();

    const visualExts = ['.ai', '.eps', '.psd', '.tiff', '.tif', '.arw', '.cr2', '.nef', '.dng'];
    const dataExts = ['.srt', '.kml', '.txt'];

    if (dataExts.includes(ext)) {
        let iconUrl = '/static/icons/default.png';
        if (ext === '.srt') iconUrl = '/static/icons/subtitle.png';
        if (ext === '.kml') iconUrl = '/static/icons/map.png';

        await pool.query("UPDATE documents SET thumbnail_url = $1 WHERE nom_fichier = $2", [iconUrl, filename]);
        await pool.query("UPDATE portal_files SET thumbnail_url = $1 WHERE filename = $2", [iconUrl, filename]);
        return;
    }

    if (!visualExts.includes(ext)) return;

    const tmpOriginal = path.join(os.tmpdir(), filename);
    const thumbFilename = `thumb_${filename}.jpg`;
    const tmpThumb = path.join(os.tmpdir(), thumbFilename);

    try {
        const blockBlobClient = containerClient.getBlockBlobClient(filename);
        const downloadResponse = await blockBlobClient.download(0);
        await pipeline(downloadResponse.readableStreamBody, fs.createWriteStream(tmpOriginal));

        await new Promise((resolve, reject) => {
            let img = gm(`${tmpOriginal}[0]`)
                .limit('memory', '512MB') 
                .limit('map', '1GB');

            if (['.tiff', '.tif', '.psd'].includes(ext)) {
                img = img.colorspace('sRGB');
            }

            img.background('#FFFFFF')
                .flatten()
                .resize(800, 800, '>')
                .quality(80)
                .setFormat('jpg')
                .write(tmpThumb, (err) => err ? reject(err) : resolve());
        });

        const thumbBlobClient = containerClient.getBlockBlobClient(thumbFilename);
        await thumbBlobClient.uploadFile(tmpThumb, {
            blobHTTPHeaders: { blobContentType: 'image/jpeg' }
        });

        const thumbUrl = thumbBlobClient.url;

        await pool.query("UPDATE documents SET thumbnail_url = $1 WHERE nom_fichier = $2", [thumbUrl, filename]);
        await pool.query("UPDATE portal_files SET thumbnail_url = $1 WHERE filename = $2", [thumbUrl, filename]);

    } catch (error) {
        const errorIcon = '/static/icons/broken_file.png';
        await pool.query("UPDATE documents SET thumbnail_url = $1 WHERE nom_fichier = $2", [errorIcon, filename]);
    } finally {
        if (fs.existsSync(tmpOriginal)) fs.unlinkSync(tmpOriginal);
        if (fs.existsSync(tmpThumb)) fs.unlinkSync(tmpThumb);
    }
}

app.get('/', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const sort = req.query.sort || 'date_desc';
    const filter = req.query.filter || 'all';
    const limit = 12;
    const offset = (page - 1) * limit;
    const ext = {
        images: ["'%.png'", "'%.jpg'", "'%.jpeg'", "'%.jpe'", "'%.gif'", "'%.bmp'", "'%.svg'", "'%.webp'"],
        videos: ["'%.mp4'", "'%.mov'", "'%.avi'", "'%.wmv'", "'%.flv'", "'%.mkv'", "'%.webm'"],
        audio: ["'%.mp3'", "'%.wav'", "'%.aac'", "'%.flac'", "'%.ogg'", "'%.m4a'"],
        documents: ["'%.pdf'", "'%.doc'", "'%.docx'", "'%.xls'", "'%.xlsx'", "'%.txt'", "'%.rtf'", "'%.odt'"],
        presentations: ["'%.ppt'", "'%.pptx'", "'%.key'", "'%.odp'"],
        others: ["'%.ai'", "'%.kml'", "'%.zip'", "'%.rar'", "'%.eps'", "'%.psd'", "'%.heic'", "'%.heif'", "'%.thm'", "'%.emf'", "'%.srt'", "'%.tif'", "'%.tiff'"]
    };
    const allKnownExts = [...ext.images, ...ext.videos, ...ext.audio, ...ext.documents, ...ext.presentations];

    try {
        let baseQuery = `FROM documents d LEFT JOIN folders f ON d.folder_id = f.id WHERE 1=1`;
        let queryParams = [];

        if (filter === 'exclusive') {
            baseQuery += ` AND d.is_exclusive = true`;
        } else if (filter === 'images') {
            baseQuery += ` AND LOWER(d.nom_fichier) LIKE ANY(ARRAY[${ext.images.join(',')}])`;
        } else if (filter === 'videos') {
            baseQuery += ` AND LOWER(d.nom_fichier) LIKE ANY(ARRAY[${ext.videos.join(',')}])`;
        } else if (filter === 'audio') {
            baseQuery += ` AND LOWER(d.nom_fichier) LIKE ANY(ARRAY[${ext.audio.join(',')}])`;
        } else if (filter === 'documents') {
            baseQuery += ` AND LOWER(d.nom_fichier) LIKE ANY(ARRAY[${ext.documents.join(',')}])`;
        } else if (filter === 'presentations') {
            baseQuery += ` AND LOWER(d.nom_fichier) LIKE ANY(ARRAY[${ext.presentations.join(',')}])`;
        } else if (filter === 'others') {
            const knownWithoutOthers = [...ext.images, ...ext.videos, ...ext.audio, ...ext.documents, ...ext.presentations];
            baseQuery += ` AND (LOWER(d.nom_fichier) LIKE ANY(ARRAY[${ext.others.join(',')}]) OR NOT LOWER(d.nom_fichier) LIKE ANY(ARRAY[${knownWithoutOthers.join(',')}]))`;
        }

        let orderBy = 'ORDER BY d.date_ajout DESC';
        if (sort === 'name_asc') orderBy = 'ORDER BY LOWER(d.nom_fichier) ASC';
        if (sort === 'name_desc') orderBy = 'ORDER BY LOWER(d.nom_fichier) DESC';
        if (sort === 'date_asc') orderBy = 'ORDER BY d.date_ajout ASC';

        const countRes = await pool.query(`SELECT COUNT(*) ${baseQuery}`, queryParams);
        const totalFiles = parseInt(countRes.rows[0].count);
        const totalPages = Math.ceil(totalFiles / limit) || 1;
        const dataQuery = `SELECT d.*, f.name as folder_name ${baseQuery} ${orderBy} LIMIT ${limit} OFFSET ${offset}`;
        const result = await pool.query(dataQuery, queryParams);

        res.render('index.html', {
            files: result.rows,
            current_page: page,
            total_pages: totalPages,
            currentSort: sort,
            currentFilter: filter,
            is_admin: req.session.is_admin,
            user_role: req.session.user_role
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur SQL lors du filtrage");
    }
});

app.get('/index', loginRequiredHtml, (req, res) => {
    res.render('page_canto.html', {
        username: req.session.username,
        user_email: req.session.user_email,
        is_admin: req.session.is_admin,
        user_role: req.session.user_role
    });
});

async function getUserRole(accessToken) {
    const adminGroupId = process.env.ADMIN_GROUP_ID;
    const moderatorGroupId = process.env.MODERATOR_GROUP_ID; 
    const uploaderGroupId = process.env.UPLOADER_GROUP_ID; 
    try {
        const client = Client.init({ authProvider: (done) => done(null, accessToken) });        
        const response = await client.api('/me/memberOf').select('id').get();
        if (response.value && response.value.length > 0) {
            const userGroupIds = response.value.map(group => group.id);            
            if (adminGroupId && userGroupIds.includes(adminGroupId)) return 'admin'; // super admin
            if (moderatorGroupId && userGroupIds.includes(moderatorGroupId)) return 'basic_admin'; // admin basique (modo)
            if (uploaderGroupId && userGroupIds.includes(uploaderGroupId)) return 'uploader'; // uploader
        }        
        return 'viewer';
    } catch (e) {
        console.warn("Erreur Graph API (Role Check):", e.message);
        return 'viewer';
    }
}

// admins et uploaders
function uploadAccessRequired(req, res, next) {
    const role = req.session.user_role;
    if (role === 'admin' || role === 'basic_admin' || role === 'uploader') {
        return next();
    }
    if (req.method === 'GET' && !req.headers.accept?.includes('application/json')) {
        return res.redirect('/');
    }
    return res.status(403).json({ status: "error", message: "Access Denied. Uploaders and Admins only." });
}


function loginRequiredHtml(req, res, next) {
    if (req.path.startsWith('/portal/')) {
      // employé de pur connecté au site principal ?
        const isInternalUser = req.session.user_email && req.session.user_email.endsWith('@pur.co'); 
        // si oui on laisse passer       
        if (isInternalUser) {
            return next();
        }
        // sinon session pour portail
        if (!req.session.portal_user_email) {
            const urlParts = req.path.split('/');
            const extractedPortalId = urlParts[2]; 
            return res.redirect(extractedPortalId && extractedPortalId !== 'login' ? `/portal/${extractedPortalId}/login` : '/login');
        }
        return next();
    }    
    if (!req.session.user_email) {
        req.session.nextUrl = req.originalUrl;
        return res.redirect('/login');
    }
    next();
}

function loginRequiredJson(req, res, next) {
    if (!req.session.user_email) return res.status(401).json({ error: "Unauthorized" });
    next();
}

function adminRequired(req, res, next) {
    if (!req.session || !req.session.is_admin) {
        if (req.method === 'GET' && !req.headers.accept?.includes('application/json')) {
            return res.redirect('/');
        }
        return res.status(403).json({ status: "error", message: "Admin Access Required" });
    }
    next();
}

function basicAdminRequired(req, res, next) {
    const role = req.session.user_role;
    if (role !== 'admin' && role !== 'basic_admin') {
        if (req.method === 'GET' && !req.headers.accept?.includes('application/json')) {
            return res.redirect('/');
        }
        return res.status(403).json({ status: "error", message: "Moderator or Admin Access Required" });
    }
    next();
}

function uploaderOrAdminRequired(req, res, next) {
    const role = req.session.user_role;
    if (role !== 'admin' && role !== 'basic_admin' && role !== 'uploader') {
        return res.status(403).json({ status: "error", message: "Admin, Moderator or Uploader Access Required" });
    }
    next();
}

// routes authentification msal entra id 
app.get('/login', (req, res) => {
    if (req.session.user_email) return res.redirect('/');
    res.render('login.html');
});

// ROUTES : AUTHENTIFICATION ENTRA ID (MSAL)
app.get('/start_auth', async (req, res) => {
    req.session.nextUrl = req.query.next || '/';
    
    try {
        const { challenge, verifier } = await cryptoProvider.generatePkceCodes();
        req.session.pkceVerifier = verifier;

        const authCodeUrlParameters = {
            scopes: ["User.Read", "GroupMember.Read.All"],
            redirectUri: process.env.REDIRECT_URI,
            codeChallenge: challenge,        
            codeChallengeMethod: "S256"
        };

        const responseUrl = await pca.getAuthCodeUrl(authCodeUrlParameters);
        res.redirect(responseUrl);
        
    } catch (error) {
        console.error("Erreur critique dans start_auth:", error);
        res.redirect('/login');
    }
});

app.get('/getAToken', async (req, res) => {
    try {
        const tokenRequest = {
            code: req.query.code,
            scopes: ["User.Read", "GroupMember.Read.All"],
            redirectUri: process.env.REDIRECT_URI,
            codeVerifier: req.session.pkceVerifier 
        };

        const response = await pca.acquireTokenByCode(tokenRequest);
        const email = (response.account.username || response.account.name || "").toLowerCase();
        const allowedDomain = (process.env.ALLOWED_DOMAIN || "pur.co").toLowerCase();

        if (!email.endsWith(`@${allowedDomain}`)) {
            req.session.destroy();
            return res.status(403).send(`Access denied: only the domain @${allowedDomain} is authorized.`);
        }

        const role = await getUserRole(response.accessToken);
        req.session.access_token = response.accessToken;
        req.session.user_email = email;
        req.session.username = email.split('@')[0];
        
        // Extract given_name and family_name from idTokenClaims if available
        const given_name = response.idTokenClaims?.given_name || "";
        const family_name = response.idTokenClaims?.family_name || "";
        const fullName = (given_name && family_name) ? `${given_name} ${family_name}` : (response.account.name || response.account.username || "");
        req.session.user_fullname = fullName;

        req.session.user_role = role;
        req.session.is_admin = (role === 'admin');
        if (insightsClient) {
                insightsClient.trackEvent({
                    name: "login_success",
                    properties: {
                        utilisateur: email
                    }
                });
        }
        const nextUrl = req.session.nextUrl || '/';
        delete req.session.nextUrl;
        
        res.redirect(nextUrl);

    } catch (error) {
        console.error("Erreur getAToken:", error);
        res.redirect('/login');
    }
});

app.get('/logout', (req, res) => {
    const userEmailToLog = req.session?.user_email || req.session?.portal_user_email || "Visiteur";
    req.session.destroy((err) => {
        insightsClient.trackEvent({
            name: "logout",
            properties: {
                utilisateur: userEmailToLog 
            }
        });
        const domaine = process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : `${req.protocol}://${req.get('host')}`;
        const postLogoutUri = `${domaine}/login`;        
        const postLogoutUriEncoded = encodeURIComponent(postLogoutUri);        
        const aadLogout = `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${postLogoutUriEncoded}`;
        res.redirect(aadLogout);
    });
});

//convertir les octets en texte lisible (KB, MB, GB)
function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0Bytes";
    if (bytes >= 1024 ** 3) return (bytes / (1024 ** 3)).toFixed(2) + "GB";
    if (bytes >= 1024 ** 2) return (bytes / (1024 ** 2)).toFixed(2) + "MB";
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + "KB";
    return bytes + "Bytes";
}

function generateSlug(name, id) {
    const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    return `${safeName}-${id}`;
}

async function updatePortalStats(portal_id) {
    try {
        const countResult = await pool.query(`
            WITH RECURSIVE folder_tree AS (
                SELECT folder_id as id FROM portal_folders WHERE portal_id = $1
                UNION
                SELECT f.id FROM folders f
                INNER JOIN folder_tree ft ON f.parent_id = ft.id
            )
            SELECT COUNT(DISTINCT filename) as count FROM (
                SELECT filename FROM portal_files WHERE portal_id = $1
                UNION
                SELECT nom_fichier FROM documents WHERE folder_id IN (SELECT id FROM folder_tree)
            ) as combined_files;
        `, [portal_id]);
        const foldersResult = await pool.query(`
            SELECT COUNT(DISTINCT folder_id) as count 
            FROM portal_folders 
            WHERE portal_id = $1;
        `, [portal_id]);
        
        const file_count = parseInt(countResult.rows[0].count || 0, 10);
        const folder_count = parseInt(foldersResult.rows[0].count || 0, 10);
        const folder_display = `${folder_count} folder${folder_count > 1 ? 's' : ''}`;
        await pool.query(`
            UPDATE portals 
            SET files = $1, size = $2, last_sync = CURRENT_DATE 
            WHERE id = $3;
        `, [file_count, folder_display, portal_id]);
        
        return { file_count, folder_display };
    } catch (e) {
        console.error("Erreur updatePortalStats:", e);
    }
}

// routes API
app.get('/get_folders', loginRequiredJson, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name, parent_id, creation_date FROM folders ORDER BY folder_order ASC, name ASC;");
        const folders = result.rows.map(f => ({
            id: f.id,
            name: f.name,
            parent_id: f.parent_id,
            creation_date: f.creation_date
        }));
        res.json({ folders });
    } catch (error) {
        console.error("Erreur get_folders:", error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.post('/update_folder_order', loginRequiredJson, basicAdminRequired, express.json(), async (req, res) => {
    try {
        const { folder_order } = req.body; 
        if (!folder_order || !Array.isArray(folder_order)) {
            return res.status(400).json({ status: "error", message: "Invalid data" });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (let item of folder_order) {
                await client.query("UPDATE folders SET folder_order = $1 WHERE id = $2;", [item.order, item.id]);
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
        res.json({ status: "success" });
    } catch (error) {
        console.error("Erreur update_folder_order:", error);
        res.status(500).json({ status: "error", message: "Erreur serveur" });
    }
});

// recherche par ia
const aiSearchCache = new Map();
const AI_CACHE_MAX_SIZE = 200;
const AI_CACHE_TTL_MS = 1000 * 60 * 60; 

async function expandSearchTermsWithAI(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = aiSearchCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < AI_CACHE_TTL_MS) {
        return cached.terms;
    }

    if (!process.env.GEMINI_API_KEY) {
        console.warn('GEMINI_API_KEY is not defined — AI search disabled.');
        return [];
    }

    try {
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + process.env.GEMINI_API_KEY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `You are assisting in expanding a search query for a corporate media library containing photos, videos, and documents organized in folders, cities, regions, and projects.
User search query: "${query}"

Provide a list of 5 to 10 closely related terms that might appear in file names, descriptions, or folder names related to this query (e.g., if the query is a country, provide its major cities, regions, or typical project names; if it is a city, provide the country and region).

Respond ONLY with a valid JSON object in this exact format, without any markdown tags, backticks, or extra text:
{"terms": ["term1", "term2", "term3"]}`
                    }]
                }],
                generationConfig: {
                    responseMimeType: "application/json"
                }
            })
        });

        if (!response.ok) {
            console.error('Gemini API error:', response.status, await response.text());
            return [];
        }

        const data = await response.json();
        const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!textResponse) return [];

        let parsed;
        try {
            const cleaned = textResponse.trim().replace(/^```json\s*|```$/g, '');
            parsed = JSON.parse(cleaned);
        } catch (e) {
            console.error('Failed to parse AI search response:', textResponse);
            return [];
        }

        const terms = Array.isArray(parsed.terms) ? parsed.terms.filter(t => typeof t === 'string' && t.trim()) : [];

        if (aiSearchCache.size >= AI_CACHE_MAX_SIZE) {
            const oldestKey = aiSearchCache.keys().next().value;
            aiSearchCache.delete(oldestKey);
        }
        aiSearchCache.set(cacheKey, { terms, timestamp: Date.now() });

        return terms;

    } catch (err) {
        console.error('expandSearchTermsWithAI (Gemini) error:', err);
        return [];
    }
}

app.get('/ai_expand_search', loginRequiredJson, async (req, res) => {
    const query = (req.query.q || '').trim();
    if (!query) return res.json({ terms: [] });
    const terms = await expandSearchTermsWithAI(query);
    res.json({ terms });
});

app.get('/search_file', loginRequiredJson, async (req, res) => {
    try {
        const filename = req.query.filename;
        const aiEnabled = req.query.ai === 'true';
        let tags = req.query.tag;
        if (tags && !Array.isArray(tags)) tags = [tags]; 
        const folder_id = req.query.folder_id;
        const page = parseInt(req.query.page || 1, 10);
        const per_page = parseInt(req.query.per_page || 100, 10);
        const offset = (page - 1) * per_page;
        const sort = req.query.sort || 'name_asc';
        const filter = req.query.filter || 'all';
        const sectionFilter = req.query.section; 
        const categoryFilter = req.query.category;

        // Termes additionnels générés par l'IA (synonymes, villes/pays liés, etc.)
        let aiTerms = [];
        if (aiEnabled && filename && filename.trim().length > 1) {
            aiTerms = await expandSearchTermsWithAI(filename.trim());
        }

        const ext = {
            images: ["'%.png'", "'%.jpg'", "'%.jpeg'", "'%.jpe'", "'%.gif'", "'%.bmp'", "'%.svg'", "'%.webp'", "'%.tif'", "'%.tiff'", "'%.avif'", "'%.dng'", "'%.cr2'", "'%.nef'", "'%.arw'"],
            videos: ["'%.mp4'", "'%.mov'", "'%.avi'", "'%.wmv'", "'%.flv'", "'%.mkv'", "'%.webm'"],
            audio: ["'%.mp3'", "'%.wav'", "'%.aac'", "'%.flac'", "'%.ogg'", "'%.m4a'"],
            documents: ["'%.pdf'", "'%.doc'", "'%.docx'", "'%.xls'", "'%.xlsx'", "'%.txt'", "'%.rtf'", "'%.odt'"],
            presentations: ["'%.ppt'", "'%.pptx'", "'%.key'", "'%.odp'"]
        };
        const allKnownExts = [...ext.images, ...ext.videos, ...ext.audio, ...ext.documents, ...ext.presentations];
        let query = `
            SELECT nom_fichier, lien_telechargement, description, tags, is_exclusive, date_ajout, date_event, folder_id, thumbnail_url,
                   COUNT(*) OVER() as total_count
            FROM documents
            WHERE 1=1
        `;
        const params = [];
        if (filename) {
            // Termes de base = mots de la requête originale + termes IA (si activée)
            const searchWords = filename.split(/\s+/).filter(w => w.length > 0);
            const allTerms = [...searchWords, ...aiTerms];

            const wordConditions = [];
            for (const word of allTerms) {
                const searchTerm = `%${word}%`;
                params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
                const pLen = params.length;
                wordConditions.push(`(nom_fichier ILIKE $${pLen - 4} OR description ILIKE $${pLen - 3} OR tags::text ILIKE $${pLen - 2} OR section ILIKE $${pLen - 1} OR category ILIKE $${pLen})`);
            }
            if (aiEnabled && aiTerms.length > 0) {
                // Mode IA : un fichier matche s'il correspond à N'IMPORTE LEQUEL des termes (original OU lié)
                query += ` AND (${wordConditions.join(" OR ")})`;
            } else {
                // Mode normal : tous les mots de la requête doivent matcher (comportement existant inchangé)
                query += wordConditions.map(c => ` AND ${c}`).join('');
            }
        }

        if (tags && tags.length > 0) {
            const tagConditions = [];
            for (const tag of tags) {
                params.push(`%${tag}%`);
                tagConditions.push(`tags::text ILIKE $${params.length}`);
            }
            query += ` AND (${tagConditions.join(" OR ")})`;
        }

        if (folder_id) {
            params.push(folder_id);
            query += ` AND folder_id = $${params.length}`;
        }

        // filtre par caté 
        if (filter === 'exclusive') {
            query += ` AND is_exclusive = TRUE`;
        } else if (filter === 'favorites') {
            const user_email = req.session.user_email || req.session.portal_user_email;
            params.push(user_email);
            query += ` AND nom_fichier IN (SELECT filename FROM user_favorites WHERE user_email = $${params.length})`;
        } 
        else if (filter === 'images') {
            query += ` AND LOWER(nom_fichier) LIKE ANY(ARRAY[${ext.images.join(',')}])`;
        } else if (filter === 'videos') {
            query += ` AND LOWER(nom_fichier) LIKE ANY(ARRAY[${ext.videos.join(',')}])`;
        } else if (filter === 'audio') {
            query += ` AND LOWER(nom_fichier) LIKE ANY(ARRAY[${ext.audio.join(',')}])`;
        } else if (filter === 'documents') {
            query += ` AND LOWER(nom_fichier) LIKE ANY(ARRAY[${ext.documents.join(',')}])`;
        } else if (filter === 'presentations') {
            query += ` AND LOWER(nom_fichier) LIKE ANY(ARRAY[${ext.presentations.join(',')}])`;
        } else if (filter === 'others') {
            query += ` AND NOT (LOWER(nom_fichier) LIKE ANY(ARRAY[${allKnownExts.join(',')}]))`;
        }

        if (sectionFilter && sectionFilter !== 'all') {
            params.push(sectionFilter);
            query += ` AND section = $${params.length}`;
        }
        if (categoryFilter && categoryFilter !== 'all') {
            params.push(categoryFilter);
            query += ` AND category = $${params.length}`;
        }

        // trie
        let orderBy = 'ORDER BY LOWER(nom_fichier) ASC'; 
        if (sort === 'name_desc') orderBy = 'ORDER BY LOWER(nom_fichier) DESC';
        if (sort === 'date_desc') orderBy = 'ORDER BY date_ajout DESC NULLS LAST';
        
        query += ` ${orderBy}`;

        // pagination
        params.push(per_page, offset);
        query += ` LIMIT $${params.length - 1} OFFSET $${params.length};`;

        const result = await pool.query(query, params);
        
        let total_count = 0;
        if (result.rows.length > 0) {
            total_count = parseInt(result.rows[0].total_count, 10);
        }

        const formatDate = (dateObj) => {
            if (!dateObj) return null;
            const d = new Date(dateObj);
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            return `${day}-${month}-${year}`;
        };

        const files = result.rows.map(row => {
            let parsedTags = [];
            try {
                if (typeof row.tags === 'string') parsedTags = JSON.parse(row.tags);
                else if (Array.isArray(row.tags)) parsedTags = row.tags;
            } catch(e) { }

            return {
                name: row.nom_fichier,
                url: row.lien_telechargement,
                description: row.description,
                tags: parsedTags,
                is_exclusive: Boolean(row.is_exclusive),
                date_ajout: formatDate(row.date_ajout),
                date_event: formatDate(row.date_event),
                folder_id: row.folder_id,
                thumbnail: row.thumbnail_url || row.lien_telechargement
            };
        });

        // ── Folders correspondants (nom de dossier matchant la requête ou les termes IA) ──
        // Inclut le chemin complet (Parent > Sous-dossier > ...) pour distinguer les homonymes
        let matchingFolders = [];
        if (filename && filename.trim().length > 0) {
            const folderTermsSet = aiEnabled ? [filename.trim(), ...aiTerms] : [filename.trim()];
            const folderParams = [];
            const folderConditions = folderTermsSet.map(term => {
                folderParams.push(`%${term}%`);
                return `name ILIKE $${folderParams.length}`;
            });
            const folderQuery = `
                WITH RECURSIVE ancestry AS (
                    -- Point de départ : les dossiers qui matchent la recherche
                    SELECT id, name, parent_id, id AS origin_id, name::text AS path, 0 AS depth
                    FROM folders
                    WHERE ${folderConditions.join(' OR ')}

                    UNION ALL

                    -- Remontée récursive vers les parents pour construire le chemin
                    SELECT f.id, f.name, f.parent_id, a.origin_id, (f.name || ' > ' || a.path)::text, a.depth + 1
                    FROM folders f
                    INNER JOIN ancestry a ON f.id = a.parent_id
                    WHERE a.depth < 10
                )
                SELECT DISTINCT ON (origin_id)
                    origin_id AS id, path
                FROM ancestry
                ORDER BY origin_id, depth DESC
                LIMIT 30;
            `;
            const folderResult = await pool.query(folderQuery, folderParams);
            matchingFolders = folderResult.rows.map(r => ({
                id: r.id,
                name: r.path.split(' > ').pop(),
                path: r.path
            }));
        }

        res.json({
            files: files,
            total: total_count,
            page: page,
            total_pages: Math.ceil(total_count / per_page),
            folders: matchingFolders,
            ai_terms: aiTerms
        });

    } catch (error) {
        console.error("Erreur search_file:", error.message);
        res.json({ files: [], total: 0, page: 1, total_pages: 0, folders: [], ai_terms: [] });
    }
});

function buildFolderHierarchy(folders) {
    const folderMap = new Map();
    folders.forEach(f => folderMap.set(f.id, { ...f, subfolders: [] }));
    const rootFolders = [];
    folders.forEach(f => {
        if (f.parent_id && folderMap.has(f.parent_id)) {
            folderMap.get(f.parent_id).subfolders.push(folderMap.get(f.id));
        } 
        else {
            rootFolders.push(folderMap.get(f.id));
        }
    });
    return rootFolders;
}

app.get('/upload', loginRequiredHtml, uploadAccessRequired, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name, parent_id FROM folders ORDER BY name;");
        const folders = buildFolderHierarchy(result.rows);
        const portalsRes = await pool.query("SELECT id, name FROM portals ORDER BY name ASC;");
        res.render('upload.html', { 
            folders: folders, 
            portals: portalsRes.rows,
            is_admin: req.session.is_admin,      
            user_role: req.session.user_role
        });
    } catch (error) {
        console.error("Erreur chargement page upload:", error);
        res.status(500).send("Erreur serveur");
    }
});

app.post('/upload', loginRequiredJson, uploadAccessRequired, (req, res, next) => {
    uploadStream.array("files")(req, res, function (err) {
        if (err) {
            if (err.message.startsWith('Extension_Error')) {
                const ext = err.message.split(':')[1];
                return res.status(400).json({ status: "error", message: `Extension '${ext}' not allowed` });
            }
            if (err.message.startsWith('FileExists_Error')) {
                const fname = err.message.split(':')[1];
                return res.status(400).json({ 
                    status: "error", 
                    message: `The file '${fname}' already exists in the database. Please rename it before uploading.` 
                });
            }
            return res.status(500).json({ status: "error", message: "Error during file transfer." });
        }
        next();
    });
}, async (req, res) => {
    try {
        const files = req.files || [];
        const descriptions = [].concat(req.body.descriptions || []);
        const tags_list = [].concat(req.body.tags || []);
        const date_events = [].concat(req.body.date_events || []);
        const folder_ids = [].concat(req.body.folder_ids || []);
        const portal_ids = [].concat(req.body.portal_ids || []);
        const sections = [].concat(req.body.sections || req.body.section || []);
        const categories = [].concat(req.body.categories || req.body.category || []);
        const uploaded_urls = [];
        const currentDate = new Date().toISOString().split('T')[0]; 
        const is_exclusives = [].concat(req.body.is_exclusives || []);
        const metadata_list = [].concat(req.body.metadata || []);
        
        const user_role = req.session.user_role; 

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const filename = file.filename;
            const blob_url = file.url;
            const size_bytes = file.size;
            const originalName = file.originalname;
            const ext = require('path').extname(originalName).toLowerCase();
            const description = descriptions[i] || "";
            
            let tags = [];
            try { tags = JSON.parse(tags_list[i] || "[]"); } catch (e) { }
            
            const folder_id = folder_ids[i] || null;
            const portal_id = (portal_ids[i] && portal_ids[i] !== "none") ? portal_ids[i] : null;
            const section = sections[i] || sections[0] || null;
            const category = categories[i] || categories[0] || null;
            let date_event = null;
            
            if (date_events[i]) {
                const parts = date_events[i].split('-');
                if (parts.length === 3) date_event = `${parts[2]}-${parts[1]}-${parts[0]}`;
            }

            const is_exclusive = (is_exclusives[i] === 'true');

            let metadata = {};
            try {
                if (metadata_list[i]) {
                    metadata = typeof metadata_list[i] === 'string' ? JSON.parse(metadata_list[i]) : metadata_list[i];
                }
            } catch (e) {
                console.error("Error parsing file metadata:", e);
            }

            // Super Admin (role 'admin') can bypass the Country/Region requirement; every other role must fill them in.
            const isAdmin = (req.session.user_role === 'admin');

            if (!isAdmin) {
                if (!metadata.country || metadata.country.trim() === "") {
                    return res.status(400).json({ 
                        status: "error", 
                        message: `The 'Country' field is mandatory for the file: ${originalName}` 
                    });
                }
                if (!metadata.region || metadata.region.trim() === "") {
                    return res.status(400).json({ 
                        status: "error", 
                        message: `The 'Region' field is mandatory for the file: ${originalName}` 
                    });
                }
            }

            metadata.author = req.session.user_fullname || req.session.username || req.session.user_email || "Unknown";

            // enregistre dans la table globale (documents)
            await pool.query(`
                INSERT INTO documents (
                    nom_fichier, lien_telechargement, description, tags, 
                    date_ajout, date_event, folder_id, section, category, is_exclusive, metadata
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
            `, [filename, blob_url, description, JSON.stringify(tags), currentDate, date_event, folder_id, section, category, is_exclusive, JSON.stringify(metadata)]);

            // si associé à un portail, enregistre dans portal_files
            if (portal_id) {
                let file_type = "Other";
                if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) file_type = "Image";
                else if (['.mp4', '.mov', '.avi', '.wmv'].includes(ext)) file_type = "Video";
                else if (['.pdf'].includes(ext)) file_type = "PDF";
                else if (['.doc', '.docx'].includes(ext)) file_type = "Document";
                else if (['.xls', '.xlsx'].includes(ext)) file_type = "Spreadsheet";
                
                let size_display;
                if (size_bytes >= 1024 ** 3) size_display = (size_bytes / (1024 ** 3)).toFixed(2) + "GB";
                else if (size_bytes >= 1024 ** 2) size_display = (size_bytes / (1024 ** 2)).toFixed(2) + "MB";
                else if (size_bytes >= 1024) size_display = (size_bytes / 1024).toFixed(2) + "KB";
                else size_display = size_bytes + "Bytes";
                
                await pool.query(`
                    INSERT INTO portal_files (portal_id, filename, description, file_url, file_type, upload_date, size_bytes, size)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
                `, [portal_id, filename, description || "No description", blob_url, file_type, currentDate, size_bytes, size_display]);
            }

            uploaded_urls.push(blob_url);
            
            if (typeof insightsClient !== 'undefined' && insightsClient) {
                insightsClient.trackEvent({
                    name: "file_uploaded",
                    properties: {
                        fichier: filename,
                        utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
                    }
                });
            }
            
            generateAndUploadThumbnail(filename, containerClient, pool);
        }
        
        res.json({ status: "success", urls: uploaded_urls });

    } catch (error) {
        console.error("Erreur lors de l'enregistrement en BDD:", error);
        res.status(500).json({ status: "error", message: "Error during database recording." });
    }
});

// route détails fichier (Modal)
app.get('/file_details', loginRequiredJson, async (req, res) => {
    try {
        const filename = req.query.filename;
        if (!filename) {
            return res.status(400).json({ error: "Filename required" });
        }

        const docResult = await pool.query(`
            SELECT description, tags, date_ajout, is_exclusive, date_event, folder_id, section, category, metadata
            FROM documents
            WHERE nom_fichier = $1;
        `, [filename]);

        if (docResult.rows.length === 0) {
            return res.status(404).json({ error: "File not found" });
        }

        const doc = docResult.rows[0];
        const portalResult = await pool.query(`
            SELECT pf.portal_id, p.name as portal_name 
            FROM portal_files pf 
            LEFT JOIN portals p ON pf.portal_id = p.id 
            WHERE pf.filename = $1 LIMIT 1;
        `, [filename]);
        
        const portal_id = portalResult.rows.length > 0 ? portalResult.rows[0].portal_id : null;
        const portal_name = portalResult.rows.length > 0 ? portalResult.rows[0].portal_name : null;
        const formatDate = (dateObj) => {
            if (!dateObj) return "";
            const d = new Date(dateObj);
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            return `${day}-${month}-${year}`;
        };

        let parsedTags = [];
        try {
            if (typeof doc.tags === 'string') parsedTags = JSON.parse(doc.tags);
            else if (Array.isArray(doc.tags)) parsedTags = doc.tags;
        } catch (e) {
        }

        res.json({
            description: doc.description || "No description",
            tags: parsedTags,
            date_ajout: formatDate(doc.date_ajout),
            is_exclusive : Boolean(doc.is_exclusive),
            date_event: formatDate(doc.date_event),
            folder_id: doc.folder_id,
            portal_id: portal_id,
            portal_name: portal_name,
            section : doc.section || "",
            category : doc.category || "",
            metadata: doc.metadata || {}
        });

    } catch (error) {
        console.error("Erreur dans file_details:", error);
        res.status(500).json({ error: "Erreur serveur interne" });
    }
});

// routes gestion folders
app.post('/create_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        const name = req.body.name;
        const parent_id = (req.body.parent_id && req.body.parent_id !== "none") ? req.body.parent_id : null;

        if (!name) {
            return res.status(400).json({ status: "error", message: "Required folder name" });
        }

        const result = await pool.query(
            "INSERT INTO folders (name, parent_id) VALUES ($1, $2) RETURNING id;",
            [name, parent_id]
        );
        const folder_id = result.rows[0].id;
        if (insightsClient) {
            insightsClient.trackEvent({
                name: "folder_created",
                properties: {
                    dossier_nom: name,
                    utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
                }
            });
        }
        res.json({ 
            status: "success", 
            folder: { id: folder_id, name: name, parent_id: parent_id } 
        });
    } catch (error) {
        console.error("Erreur create_folder:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// supprimer un dossier
app.post('/delete_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        const folder_id = req.body.folder_id;

        if (!folder_id) {
            return res.status(400).json({ status: "error", message: "ID du dossier requis" });
        }

        const delRes = await pool.query(`
            WITH RECURSIVE folder_tree AS (
                SELECT id, name FROM folders WHERE id = $1
                UNION ALL
                SELECT f.id, f.name FROM folders f
                INNER JOIN folder_tree ft ON f.parent_id = ft.id
            )
            DELETE FROM folders 
            WHERE id IN (SELECT id FROM folder_tree) 
            RETURNING name;
        `, [folder_id]);
        const folderName = delRes.rows.length > 0 ? delRes.rows[0].name : "Dossier Inconnu";
        insightsClient.trackEvent({
            name: "folder_deleted",
            properties: {
                dossier_nom: folderName,
                utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
            }
        });
        res.json({ status: "success" });
    } catch (error) {
        console.error("Erreur delete_folder:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// rename un dossier
app.post('/rename_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        const { folder_id, new_name } = req.body;
        if (!folder_id || !new_name || new_name.trim() === "") {
            return res.status(400).json({ status: "error", message: "Valid ID and new name required" });
        }
        const cleanName = new_name.trim();
        const selectRes = await pool.query("SELECT name FROM folders WHERE id = $1;", [folder_id]);
        if (selectRes.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "folder not found" });
        }
        const ancienNom = selectRes.rows[0].name;
        await pool.query("UPDATE folders SET name = $1 WHERE id = $2;", [cleanName, folder_id]);
        if (typeof insightsClient !== 'undefined' && insightsClient) {
            insightsClient.trackEvent({
                name: "folder_renamed",
                properties: {
                    ancien_nom: ancienNom,
                    nouveau_nom: cleanName,
                    dossier_id: folder_id,
                    admin: req.session.user_email
                }
            });
        }
        res.json({ status: "success", new_name: cleanName });
    } catch (error) {
        console.error("Erreur rename_folder:", error);
        res.status(500).json({ status: "error", message: "Error renaming in the database" });
    }
});

app.post('/update_file_folder', async (req, res) => {
    try {
        const filename = req.body?.filename || req.query?.filename;
        const folder_id = req.body?.folder_id || req.query?.folder_id;
        if (!filename || !folder_id) {
            return res.status(400).json({ status: 'error', message: 'Parameters missing' });
        }
        const docCheck = await pool.query("SELECT * FROM documents WHERE nom_fichier = $1", [filename]);
        if (docCheck.rows.length > 0) {
            await pool.query("UPDATE documents SET folder_id = $1 WHERE nom_fichier = $2", [folder_id, filename]);
        } 
        else {
            const portalFileCheck = await pool.query("SELECT * FROM portal_files WHERE filename = $1", [filename]);

            if (portalFileCheck.rows.length > 0) {
                const fileData = portalFileCheck.rows[0];
                await pool.query(`
                    INSERT INTO documents (nom_fichier, lien_telechargement, description, type_doc, folder_id, date_ajout)
                    VALUES ($1, $2, $3, $4, $5, NOW())
                `, [fileData.filename, fileData.file_url, fileData.description, fileData.file_type, folder_id]);

                await pool.query("DELETE FROM portal_files WHERE filename = $1", [filename]);
            } 
            else {
                return res.status(404).json({ status: 'error', message: 'File not found in the database.' });
            }
        }
        res.json({ status: 'success', message: 'File assigned successfully.' });
        
    } catch (error) {
        console.error("Erreur critique /update_file_folder :", error);
        res.status(500).json({ status: 'error', message: 'Internal Server Error' });
    }
});


app.post('/r_file_folder', async (req, res) => {
    try {
        const filename = req.body?.filename || req.query?.filename;
        const portal_id = req.body?.portal_id || req.query?.portal_id || req.session?.portal_access;
        if (!filename) return res.status(400).json({ status: 'error', message: 'Nom de fichier manquant' });
        const docCheck = await pool.query("SELECT * FROM documents WHERE nom_fichier = $1", [filename]);
        if (docCheck.rows.length > 0) {
            const docData = docCheck.rows[0];
            await pool.query(`
                INSERT INTO portal_files (portal_id, filename, file_url, description, file_type, upload_date)
                VALUES ($1, $2, $3, $4, $5, NOW())
            `, [portal_id, docData.nom_fichier, docData.lien_telechargement, docData.description, docData.type_doc]);
            await pool.query("DELETE FROM documents WHERE nom_fichier = $1", [filename]);

            res.json({ status: 'success', message: 'File removed from the folder and placed back in the root directory.' });
        } 
        else {
            res.status(404).json({ status: 'error', message: 'File not found.' });
        }
    } catch (error) {
        console.error("Erreur critique /r_file_folder :", error);
        res.status(500).json({ status: 'error', message: 'Error server' });
    }
});

// ASSIGNATION EN MASSE DE FICHIERS À UN DOSSIER
app.post('/bulk_update_file_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        const { folder_id, filenames } = req.body; 
        const filesArray = JSON.parse(filenames || "[]");
        const targetFolder = (folder_id && folder_id !== "none" && folder_id !== "") ? parseInt(folder_id, 10) : null;
        if (filesArray.length === 0) {
            return res.status(400).json({ status: "error", message: "No files selected" });
        }
        await pool.query(
            "UPDATE documents SET folder_id = $1 WHERE nom_fichier = ANY($2);",
            [targetFolder, filesArray]
        );
        res.json({ 
            status: "success", 
            message: `${filesArray.length} files have been moved successfully.` 
        });
    } catch (error) {
        console.error("Erreur bulk_update_file_folder:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// ASSIGNATION EN MASSE DE FICHIERS À UN PORTAIL
app.post('/bulk_update_file_portal', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        const { portal_id, filenames } = req.body; 
        const filesArray = JSON.parse(filenames || "[]");
        if (filesArray.length === 0) {
            return res.status(400).json({ status: "error", message: "No files selected" });
        }
        if (!portal_id || portal_id === "none") {
            return res.status(400).json({ status: "error", message: "No portal selected" });
        }

        // Check if portal has root_folder_id (Dossier Plafond)
        const portalCheck = await pool.query("SELECT root_folder_id, name FROM portals WHERE id = $1;", [portal_id]);
        if (portalCheck.rows.length > 0 && portalCheck.rows[0].root_folder_id) {
            const root_id = portalCheck.rows[0].root_folder_id;
            const portalName = portalCheck.rows[0].name;
            
            const fileCheck = await pool.query(`
                WITH RECURSIVE folder_tree AS (
                    SELECT id FROM folders WHERE id = $1
                    UNION
                    SELECT f.id FROM folders f
                    INNER JOIN folder_tree ft ON f.parent_id = ft.id
                )
                SELECT d.nom_fichier, f.name as folder_name 
                FROM documents d
                LEFT JOIN folders f ON f.id = d.folder_id
                WHERE d.nom_fichier = ANY($2::text[]) 
                  AND (d.folder_id IS NULL OR d.folder_id NOT IN (SELECT id FROM folder_tree));
            `, [root_id, filesArray]);
            
            if (fileCheck.rows.length > 0) {
                const offendingFile = fileCheck.rows[0].nom_fichier;
                const folder_name = fileCheck.rows[0].folder_name || "Root";
                return res.status(400).json({ 
                    status: "error", 
                    message: `⚠️ Cannot assign files: File '${offendingFile}' is in folder '${folder_name}' which is outside of the portal's Root Folder hierarchy (${portalName}).` 
                });
            }
        }

        let assignedCount = 0;
        for (const filename of filesArray) {
            const exist = await pool.query("SELECT id FROM portal_files WHERE filename = $1 AND portal_id = $2;", [filename, portal_id]);
            if (exist.rows.length === 0) {
                const docRes = await pool.query(`
                    SELECT nom_fichier, lien_telechargement, description, tags, date_ajout 
                    FROM documents WHERE nom_fichier = $1;
                `, [filename]);
                if (docRes.rows.length > 0) {
                    const doc = docRes.rows[0];
                    const ext = require('path').extname(filename).toLowerCase();
                    let file_type = "Other";
                    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) file_type = "Image";
                    else if (['.mp4', '.mov', '.avi', '.wmv'].includes(ext)) file_type = "Video";
                    else if (['.pdf'].includes(ext)) file_type = "PDF";
                    else if (['.doc', '.docx'].includes(ext)) file_type = "Document";
                    else if (['.xls', '.xlsx'].includes(ext)) file_type = "Spreadsheet";
                    
                    const blockBlobClient = containerClient.getBlockBlobClient(filename);
                    const props = await blockBlobClient.getProperties();
                    const size_bytes = props.contentLength || 0;

                    await pool.query(`
                        INSERT INTO portal_files (portal_id, filename, description, file_url, file_type, upload_date, size_bytes, size)
                        VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7, $8);
                    `, [portal_id, filename, doc.description || "No description", doc.lien_telechargement, file_type, doc.date_ajout, size_bytes, formatBytes(size_bytes)]);
                    assignedCount++;
                }
            }
        }

        await updatePortalStats(portal_id);
        res.json({ 
            status: "success", 
            message: `${assignedCount} files have been successfully assigned to the portal.` 
        });
    } catch (error) {
        console.error("Erreur bulk_update_file_portal:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.post('/remove_file_portal', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        const { filename, portal_id } = req.body;
        
        if (!filename || !portal_id) {
            return res.status(400).json({ status: "error", message: "Filename and portal ID are required" });
        }

        await pool.query(
            "DELETE FROM portal_files WHERE filename = $1 AND portal_id = $2;",
            [filename, portal_id]
        );
        
        // Also remove the folder assignment from the documents table!
        await pool.query(
            "UPDATE documents SET folder_id = NULL WHERE nom_fichier = $1;",
            [filename]
        );
        
        const countRes = await pool.query("SELECT COUNT(*) FROM portal_files WHERE portal_id = $1;", [portal_id]);
        const remainingFiles = parseInt(countRes.rows[0].count, 10);
        
        if (remainingFiles > 0) {
            await updatePortalStats(portal_id);
        } 
        else {
            await pool.query(`
                UPDATE portals 
                SET files = 0, size = '0Bytes', last_sync = CURRENT_DATE 
                WHERE id = $1;
            `, [portal_id]);
        }
        insightsClient.trackEvent({
            name: "remove_file_from_folder",
            properties: {
                fichier: filename,
                utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
            }
        });
        insightsClient.trackEvent({
            name: "remove_file_portal",
            properties: {
                fichier: filename,
                utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
            }
        });
        res.json({ status: "success" });
    } catch (error) {
        console.error("Erreur remove_file_from_portal:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.get('/update_portal_files_sizes', loginRequiredJson, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, filename FROM portal_files;");
        const files = result.rows;
        let updatedCount = 0;

        for (let file of files) {
            const blockBlobClient = containerClient.getBlockBlobClient(file.filename);
            let sizeBytes = 0;
            
            try {
                const props = await blockBlobClient.getProperties();
                sizeBytes = props.contentLength;
            } catch (azureErr) {
                console.error(`Impossible de lire la taille pour ${file.filename}`);
            }

            const sizeDisplay = formatBytes(sizeBytes); 

            await pool.query(
                "UPDATE portal_files SET size_bytes = $1, size = $2 WHERE id = $3;",
                [sizeBytes, sizeDisplay, file.id]
            );
            updatedCount++;
        }
        const portalsRes = await pool.query("SELECT id FROM portals;");
        for (let portal of portalsRes.rows) {
            await updatePortalStats(portal.id);
        }

        res.json({
            status: "success", 
            message: `Updated sizes for ${updatedCount} files`
        });
        
    } catch (error) {
        console.error("Erreur update_portal_files_sizes:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// routes suppr et syncro
// retier un fichier de son dossier
app.post('/remove_file_from_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        const filename = req.body.filename;
        
        if (!filename) {
            return res.status(400).json({ status: "error", message: "Required file name" });
        }

        await pool.query(
            "UPDATE documents SET folder_id = NULL WHERE nom_fichier = $1;",
            [filename]
        );
        insightsClient.trackEvent({
            name: "remove_file_from_folder",
            properties: {
                fichier: filename,
                utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
            }
        });
        res.json({ status: "success" });
    } catch (error) {
        console.error("Erreur remove_file_from_folder:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});



// Synchroniser (vérifier) le dossier actuel d'un fichier
app.post('/sync_file_folder', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        const filename = req.body.filename;
        
        if (!filename) {
            return res.status(400).json({ status: "error", message: "Required file name" });
        }
        const result = await pool.query(
            "SELECT folder_id FROM documents WHERE nom_fichier = $1;",
            [filename]
        );
        const current_folder_id = result.rows.length > 0 ? result.rows[0].folder_id : null;
        res.json({
            status: "success", 
            has_folder: current_folder_id !== null,
            folder_id: current_folder_id
        });
    } catch (error) {
        console.error("Erreur sync_file_folder:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.post('/remove_file_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    const filename = req.body.filename;
    if (!filename) {
        return res.status(400).json({ 
            status: "error", 
            message: "Le nom du fichier (filename) est manquant dans la requête." 
        });
    }
    try {
        const query = "UPDATE documents SET folder_id = NULL WHERE nom_fichier = $1";
        const result = await pool.query(query, [filename]);

        if (result.rowCount > 0) {
            res.json({ status: "success", message: "File removed from folder" });
        } 
        else {
            res.status(404).json({ status: "error", message: "File not found in database" });
        }
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

// réassigner fichier a un folder
app.post('/assign_file_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    const { filename, folder_id } = req.body;
    if (!filename || !folder_id) {
        return res.status(400).json({ 
            status: "error", 
            message: "Nom du fichier ou ID du dossier manquant." 
        });
    }

    try {
        const query = "UPDATE documents SET folder_id = $1 WHERE nom_fichier = $2";
        const result = await pool.query(query, [folder_id, filename]);

        if (result.rowCount > 0) {
            insightsClient.trackEvent({
            name: "fichier_reassigner_avec_succes",
            properties: {
                fichier: filename,
                utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
            }
        });
            res.json({ status: "success", message: "File successfully reassigned",
    folder_id: folder_id});
        } 
        else {
            res.status(404).json({ status: "error", message: "File not found" });
        }
    } catch (error) {
        console.error("Erreur SQL lors de l'assignation:", error);
        res.status(500).json({ status: "error", message: "Internal Server Error" });
    }
});

// suppr définitivement un fichier (Azure + bdd)
app.post('/delete', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const filename = req.body.filename;
        const confirmation = req.body.confirmation === "on";
        if (!confirmation) {
            return res.status(400).json({ status: "error", message: "Confirmation required" });
        }
        if (!filename) {
            return res.status(400).json({ status: "error", message: "Required file name" });
        }
        // suppr dans azure
        const blockBlobClient = containerClient.getBlockBlobClient(filename);
        try {
            await blockBlobClient.deleteIfExists(); 
        } catch (azureError) {
            console.error("Erreur Azure:", azureError);
            return res.status(500).json({ status: "error", message: `Azure error: ${azureError.message}` });
        }

        // identifier portail qui contient le fichier avant de le suppr de la bdd
        const portalsResult = await pool.query("SELECT portal_id FROM portal_files WHERE filename = $1;", [filename]);
        const affectedPortals = portalsResult.rows.map(row => row.portal_id);

        if (affectedPortals.length > 0) {
            await pool.query("DELETE FROM portal_files WHERE filename = $1;", [filename]);
        }

        // suppr du site principal
        await pool.query("DELETE FROM documents WHERE nom_fichier = $1;", [filename]);
        // suppr aussi du coup des favoris
        await pool.query("DELETE FROM user_favorites WHERE filename = $1;", [filename]);
        for (let portal_id of affectedPortals) {
            await updatePortalStats(portal_id);
        }
        insightsClient.trackEvent({
            name: "Fichier_Supprime",
            properties: {
                fichier: filename,
                utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
            }
        });
        res.json({ status: "success", message: `File ${filename} successfully deleted` });

    } catch (error) {
        console.error("Erreur delete_files:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// suppression en masse de fichiers
app.post('/bulk_delete', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const filenames = JSON.parse(req.body.filenames || '[]');
        if (!Array.isArray(filenames) || filenames.length === 0) {
            return res.status(400).json({ status: 'error', message: 'No files specified' });
        }

        const errors = [];
        for (const filename of filenames) {
            try {
                // suppr Azure
                const blockBlobClient = containerClient.getBlockBlobClient(filename);
                await blockBlobClient.deleteIfExists();

                // identifier portails concernés
                const portalsResult = await pool.query("SELECT portal_id FROM portal_files WHERE filename = $1;", [filename]);
                const affectedPortals = portalsResult.rows.map(r => r.portal_id);
                if (affectedPortals.length > 0) {
                    await pool.query("DELETE FROM portal_files WHERE filename = $1;", [filename]);
                }

                // suppr BDD principale + favoris
                await pool.query("DELETE FROM documents WHERE nom_fichier = $1;", [filename]);
                await pool.query("DELETE FROM user_favorites WHERE filename = $1;", [filename]);

                for (const portal_id of affectedPortals) {
                    await updatePortalStats(portal_id);
                }

                insightsClient.trackEvent({
                    name: 'file_deleted',
                    properties: {
                        fichier: filename,
                        utilisateur: req.session.user_email || req.session.portal_user_email || 'Visiteur'
                    }
                });
            } catch (err) {
                console.error(`Bulk delete error for ${filename}:`, err);
                errors.push(filename);
            }
        }

        if (errors.length > 0) {
            return res.json({ status: 'partial', message: `${filenames.length - errors.length} deleted, ${errors.length} failed.`, failed: errors });
        }
        res.json({ status: 'success', message: `${filenames.length} file(s) deleted successfully.` });

    } catch (error) {
        console.error('Bulk delete error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});
app.post('/update_exclusive', loginRequiredJson, uploaderOrAdminRequired, upload.none(), async (req, res) => {
    const role = req.session.user_role;
    if (role !== 'admin' && role != 'basic_admin' && role !== 'uploader') {
        return res.status(403).json({ status: "error", message: "Access denied. Reserved for administrators and uploaders." });
    }
    try {
        const filename = req.body.filename;
        const is_exclusive = req.body.is_exclusive === 'true';

        if (!filename) {
            return res.status(400).json({ status: "error", message: "Required file name" });
        }
        const result = await pool.query(
            "UPDATE documents SET is_exclusive = $1 WHERE nom_fichier = $2 RETURNING is_exclusive;",
            [is_exclusive, filename]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "File not found" });
        }
        res.json({
            status: "success",
            is_exclusive: Boolean(result.rows[0].is_exclusive)
        });
    } catch (error) {
        console.error("Erreur update_exclusive:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// gestion pages portails
// liste de tous les portails
app.get('/portals', loginRequiredHtml, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name, url, access, creation_date, last_sync FROM portals ORDER BY name;");
        const portals_list = [];        
        for (let row of result.rows) {
            const countResult = await pool.query(`
                WITH RECURSIVE folder_tree AS (
                    SELECT folder_id as id FROM portal_folders WHERE portal_id = $1
                    UNION
                    SELECT f.id FROM folders f
                    INNER JOIN folder_tree ft ON f.parent_id = ft.id
                )
                SELECT COUNT(DISTINCT filename) as count FROM (
                    SELECT filename FROM portal_files WHERE portal_id = $1
                    UNION
                    SELECT nom_fichier FROM documents WHERE folder_id IN (SELECT id FROM folder_tree)
                ) as combined_files;
            `, [row.id]);

            const foldersResult = await pool.query(`
                SELECT COUNT(DISTINCT folder_id) as count 
                FROM portal_folders 
                WHERE portal_id = $1;
            `, [row.id]);
            
            const file_count = parseInt(countResult.rows[0].count || 0, 10);
            const folder_count = parseInt(foldersResult.rows[0].count || 0, 10);
            
            portals_list.push({
                id: row.id,
                name: row.name,
                url: row.url,
                access: row.access,
                files: file_count,
                size: `${folder_count} folder${folder_count > 1 ? 's' : ''}`, 
                creation_date: row.creation_date ? new Date(row.creation_date).toLocaleDateString('fr-FR').replace(/\//g, '-') : "",
                last_sync: row.last_sync ? new Date(row.last_sync).toLocaleDateString('fr-FR').replace(/\//g, '-') : "",
                linked_folder_id: row.linked_folder_id
            });
        }

        res.render('portals.html', { portals: portals_list, is_admin: req.session.is_admin, user_role: req.session.user_role });
    } catch (error) {
        console.error("Erreur /portals:", error);
        res.status(500).send("Erreur serveur");
    }
});

app.get('/get_all_portals', loginRequiredJson, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name FROM portals ORDER BY name ASC;");
        const portals = result.rows.map(row => ({
            id: row.id,
            name: row.name
        }));
        res.json({ portals: portals });
    } catch (error) {
        console.error("Erreur /get_all_portals:", error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

async function getPortalInfo(identifier) {
    // chercher avec id classique ou le slug ("puratos-30")
    const res = await pool.query("SELECT id, name, slug FROM portals WHERE id::text = $1 OR slug = $1 LIMIT 1;", [identifier]);
    return res.rows.length > 0 ? res.rows[0] : null;
}

// page d'un portail spécifique
app.get('/portal/:portal_id', async (req, res) => {
    const identifier = req.params.portal_id; 
    try {
        const portalRes = await pool.query("SELECT * FROM portals WHERE id::text = $1 OR slug = $1;", [identifier]);
        if (portalRes.rows.length === 0) return res.redirect('/portals');
        
        const portalRow = portalRes.rows[0];
        const real_portal_id = portalRow.id; 
        const slug = portalRow.slug || real_portal_id; 
        
        if (identifier == real_portal_id.toString() && portalRow.slug) {
            return res.redirect(`/portal/${portalRow.slug}`);
        }
        
        const isAdmin = req.session.is_admin === true; 
        const isGlobalAuth = !!req.session.user_email; 
        const isAuthorizedPortalUser = !!req.session.portal_user_email && (req.session.portal_access == real_portal_id); 
        if (!isGlobalAuth && !isAuthorizedPortalUser) return res.redirect(`/portal/${slug}/login`);
        const linkedFoldersRes = await pool.query(`
            SELECT f.id, f.name, f.creation_date, pf.col_span, pf.row_span, pf.position, pf.custom_title, pf.custom_title_color
            FROM folders f
            JOIN portal_folders pf ON f.id = pf.folder_id
            WHERE pf.portal_id = $1 
            ORDER BY pf.position ASC NULLS LAST, f.name ASC;
        `, [real_portal_id]);
        
        const projectCards = [];
        for (let folder of linkedFoldersRes.rows) {
            const coverRes = await pool.query(`
            WITH RECURSIVE folder_tree AS (
                SELECT id FROM folders WHERE id = $1
                UNION
                SELECT f.id FROM folders f
                INNER JOIN folder_tree ft ON f.parent_id = ft.id
            )
            SELECT d.lien_telechargement,
                   CASE WHEN d.nom_fichier ILIKE '%.pdf' THEN 2 ELSE 1 END as priority
            FROM documents d
            JOIN folder_tree ft ON d.folder_id = ft.id
            WHERE d.nom_fichier ILIKE ANY(ARRAY['%.png', '%.jpg', '%.jpeg', '%.webp', '%.gif', '%.pdf'])
            ORDER BY priority ASC, d.date_ajout DESC
            LIMIT 1;
        `, [folder.id]);

        const heroUrl = coverRes.rows.length > 0 ? coverRes.rows[0].lien_telechargement : null;
        const isPdfCover = heroUrl ? heroUrl.toLowerCase().includes('.pdf') : false; 
        let year = folder.creation_date ? new Date(folder.creation_date).getFullYear() : '2024';
        projectCards.push({
            folder_id: folder.id,
            folder_name: folder.name,
            hero_image_url: heroUrl || '/static/foret.jpg',
            is_pdf_cover: isPdfCover, 
            year: year,
            col_span: folder.col_span || 1,
            row_span: folder.row_span || 1,
            custom_title: folder.custom_title,
            custom_title_color: folder.custom_title_color || '#000000'

        });
    }
        
        const formatDate = (dateString) => {
            if (!dateString) return 'N/A';
            const d = new Date(dateString);
            if (isNaN(d.getTime())) return 'N/A'; 
            return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth()+1).padStart(2, '0')}-${d.getFullYear()}`;        };
        
        portalRow.display_creation_date = formatDate(portalRow.creation_date);
        portalRow.display_last_sync = formatDate(portalRow.last_sync);
        portalRow.display_size = portalRow.size || '0 B';    
        const looseFilesRes = await pool.query(`
            WITH RECURSIVE portal_allowed_folders AS (
                SELECT id FROM folders WHERE id = (SELECT root_folder_id FROM portals WHERE id = $1)
                
                UNION
                
                SELECT folder_id as id FROM portal_folders WHERE portal_id = $1 AND (SELECT root_folder_id FROM portals WHERE id = $1) IS NULL
                
                UNION ALL
                
                SELECT f.id FROM folders f
                INNER JOIN portal_allowed_folders paf ON f.parent_id = paf.id
            )
            SELECT pf.*, d.folder_id, f.name AS folder_name
            FROM portal_files pf
            LEFT JOIN documents d ON d.nom_fichier = pf.filename
            LEFT JOIN folders f ON f.id = d.folder_id
            WHERE pf.portal_id = $1 
              AND (d.folder_id IS NULL OR d.folder_id NOT IN (SELECT id FROM portal_allowed_folders))
            ORDER BY pf.upload_date DESC NULLS LAST;
        `, [real_portal_id]);

        let total_files_count = 0;
        let total_folders_count = 0;

        if (portalRow.root_folder_id) {
            const countFilesRes = await pool.query(`
                WITH RECURSIVE folder_tree AS (
                    SELECT id FROM folders WHERE id = $1
                    UNION
                    SELECT f.id FROM folders f
                    INNER JOIN folder_tree ft ON f.parent_id = ft.id
                )
                SELECT COUNT(DISTINCT nom_fichier) as count FROM documents WHERE folder_id IN (SELECT id FROM folder_tree);
            `, [portalRow.root_folder_id]);
            total_files_count = parseInt(countFilesRes.rows[0].count || 0, 10);

            const countFoldersRes = await pool.query(`
                WITH RECURSIVE folder_tree AS (
                    SELECT id FROM folders WHERE id = $1
                    UNION ALL
                    SELECT f.id FROM folders f
                    INNER JOIN folder_tree ft ON f.parent_id = ft.id
                )
                SELECT COUNT(*) - 1 as count FROM folder_tree;
            `, [portalRow.root_folder_id]);
            total_folders_count = parseInt(countFoldersRes.rows[0].count || 0, 10);
            if (total_folders_count < 0) total_folders_count = 0;
        } else {
            const totalFilesRes = await pool.query(`
                WITH RECURSIVE folder_tree AS (
                    SELECT folder_id as id FROM portal_folders WHERE portal_id = $1
                    UNION
                    SELECT f.id FROM folders f
                    INNER JOIN folder_tree ft ON f.parent_id = ft.id
                )
                SELECT COUNT(DISTINCT filename) as count FROM (
                    SELECT filename FROM portal_files WHERE portal_id = $1
                    UNION
                    SELECT nom_fichier FROM documents WHERE folder_id IN (SELECT id FROM folder_tree)
                ) as combined_files;
            `, [real_portal_id]);
            total_files_count = parseInt(totalFilesRes.rows[0].count || 0, 10);

            const totalFoldersRes = await pool.query(`
                SELECT COUNT(DISTINCT folder_id) as count 
                FROM portal_folders 
                WHERE portal_id = $1;
            `, [real_portal_id]);
            total_folders_count = parseInt(totalFoldersRes.rows[0].count || 0, 10);
        }

        const looseFiles = looseFilesRes.rows.map(row => ({
            filename: row.filename,
            file_url: row.file_url,
            description: row.description || "No description",
            file_type: row.file_type || (row.filename && row.filename.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? 'Image' : 'File'),
            size: row.size || '0 B', 
            upload_date: formatDate(row.upload_date || row.created_at),
            folder_name: row.folder_name || null,

        }));

        res.render('portal_page.html', { 
            portal: portalRow, 
            projectCards: projectCards, 
            looseFiles: looseFiles,
            is_admin: isAdmin,
            user_role: req.session.user_role,
            user_email: req.session.user_email || req.session.portal_user_email,
            username: req.session.username || "Client",
            total_files_count: total_files_count,
            total_folders_count: total_folders_count
        });
        
    } catch (error) {
        console.error("Erreur Vitrine Portail :", error); 
        res.status(500).send("Erreur serveur");
    }
});

// modif taille des folders dans portails 
app.post('/portal/:portal_id/layout', adminRequired, upload.none(), async (req, res) => {
    try {
        const p = await pool.query("SELECT id FROM portals WHERE id::text = $1 OR slug = $1;", [req.params.portal_id]);
        if (p.rows.length === 0) return res.status(404).json({ status: "error", message: "Portal not found" });
        const portalId = p.rows[0].id;
        const items = JSON.parse(req.body.layout || "[]");
        for (const it of items) {
            await pool.query(
                `UPDATE portal_folders SET col_span = $1, row_span = $2, position = $3, custom_title = $4, custom_title_color = $5
                 WHERE portal_id = $6 AND folder_id = $7`,
                [it.col_span, it.row_span, it.position, it.custom_title, it.custom_title_color, portalId, it.folder_id]
            );
        }
        res.json({ status: "success" });
    } catch (e) {
        res.status(500).json({ status: "error", message: e.message });
    }
});

// sandbox (vue)
app.get('/portal/:portal_id/folder/:folder_id', loginRequiredHtml, async (req, res) => {
    const identifier = req.params.portal_id; 
    const targetFolderId = parseInt(req.params.folder_id, 10);

    try {
        const portalRes = await pool.query("SELECT * FROM portals WHERE id::text = $1 OR slug = $1;", [identifier]);
        if (portalRes.rows.length === 0) return res.redirect('/portals');
        const portalRow = portalRes.rows[0];
        const real_portal_id = portalRow.id; 
        const slug = portalRow.slug || real_portal_id; 
        const isAdmin = req.session.is_admin === true; 
        const isGlobalAuth = !!req.session.user_email; 
        const isAuthorizedPortalUser = !!req.session.portal_user_email && (req.session.portal_access == real_portal_id); 

        if (!isGlobalAuth && !isAuthorizedPortalUser) return res.redirect(`/portal/${slug}/login`);

        const rootCheck = await pool.query("SELECT folder_id FROM portal_folders WHERE portal_id = $1;", [real_portal_id]);
        let allowedRoots = rootCheck.rows.map(r => r.folder_id);
        if (portalRow.root_folder_id && !allowedRoots.includes(portalRow.root_folder_id)) {
            allowedRoots.push(portalRow.root_folder_id);
        }
        const allFoldersRes = await pool.query("SELECT id, name, parent_id, creation_date FROM folders ORDER BY name;");
        const allFolders = allFoldersRes.rows;
        let currentRoot = null;
        let tempId = targetFolderId;
        while(tempId) {
            if (allowedRoots.includes(tempId)) {
                currentRoot = tempId;
            }
            const parent = allFolders.find(f => f.id === tempId);
            tempId = parent ? parent.parent_id : null;
        }
        if (!currentRoot && !isAdmin) {
            return res.status(403).send("Access denied: This folder does not belong to your account.");
        }
        if (!currentRoot && isAdmin) currentRoot = targetFolderId;
        let allowedDescendants = new Set([currentRoot]);
        let added = true;
        while(added) {
            added = false;
            for(let f of allFolders) {
                if (f.parent_id && allowedDescendants.has(f.parent_id) && !allowedDescendants.has(f.id)) {
                    allowedDescendants.add(f.id);
                    added = true;
                }
            }
        }

        let projectFoldersIds = new Set([...allowedDescendants]);
        let pId = allFolders.find(f => f.id === currentRoot)?.parent_id;
        while(pId) {
            projectFoldersIds.add(pId);
            pId = allFolders.find(f => f.id === pId)?.parent_id;
        }
        
        const projectFolders = allFolders.filter(f => projectFoldersIds.has(f.id));
        const filesRes = await pool.query(`
            SELECT d.id as doc_id, d.nom_fichier as filename, d.lien_telechargement as file_url, 
                   d.description, d.date_ajout, d.date_event, d.tags, d.is_exclusive, f.name as folder_name, d.folder_id,
                   d.section, d.category
            FROM documents d
            LEFT JOIN folders f ON d.folder_id = f.id
            WHERE d.folder_id = ANY($1::int[]) 
            ORDER BY d.date_ajout DESC NULLS LAST;
        `, [Array.from(projectFoldersIds)]);

        const formatDate = (dateObj) => {
            if (!dateObj) return 'N/A';
            const d = new Date(dateObj);
            if (isNaN(d.getTime())) return 'N/A';
            return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth()+1).padStart(2, '0')}-${d.getFullYear()}`;
        };

        const files = filesRes.rows.map(row => {
            let parsedTags = [];
            try {
                if (typeof row.tags === 'string') parsedTags = JSON.parse(row.tags);
                else if (Array.isArray(row.tags)) parsedTags = row.tags;
            } catch(e) {}

            return {
                name: row.filename,
                url: row.file_url,
                description: row.description || "No description",
                tags: parsedTags,
                is_exclusive: Boolean(row.is_exclusive),
                date_ajout: formatDate(row.date_ajout),
                date_event: formatDate(row.date_event),
                folder_id: row.folder_id,
                section: row.section || "",
                category: row.category || ""
            };
        });

        res.render('page_canto.html', {
            username: req.session.username || (req.session.portal_user_email ? req.session.portal_user_email.split('@')[0] : "Client"),
            user_email: req.session.user_email || req.session.portal_user_email,
            is_admin: isAdmin,
            user_role: req.session.user_role,
            is_sandbox: true,
            portal_slug: slug,
            current_folder_id: targetFolderId,
            project_folders_json: JSON.stringify(projectFolders),
            sandbox_files_json: JSON.stringify(files)
        });

    } catch (error) {
        console.error("Erreur critique Sandbox:", error);
        res.status(500).send("Erreur serveur.");
    }
});

// routes gestion portails
app.post('/add_portal', loginRequiredJson, async (req, res) => {
    try {
        const { name, access = 'Public', folders, linked_folder_ids, root_folder_id } = req.body;        
        if (!name) return res.status(400).json({ status: "error", message: "Name is required" });
        const existRes = await pool.query("SELECT id FROM portals WHERE name = $1;", [name]);
        if (existRes.rows.length > 0) return res.status(400).json({ status: "error", message: "Portal with this name already exists" });

        const raw = JSON.parse(folders || linked_folder_ids || "[]");
        const chosenFolders = raw.map(item =>
            (item && typeof item === 'object')
                ? { id: parseInt(item.id), size: item.size || 'standard' }
                : { id: parseInt(item), size: 'standard' }
        );

        if (root_folder_id && chosenFolders.length > 0) {
            const checkFoldersRes = await pool.query(`
                WITH RECURSIVE folder_tree AS (
                    SELECT id FROM folders WHERE id = $1
                    UNION
                    SELECT f.id FROM folders f
                    INNER JOIN folder_tree ft ON f.parent_id = ft.id
                )
                SELECT id, name FROM folders 
                WHERE id = ANY($2::int[]) AND id NOT IN (SELECT id FROM folder_tree);
            `, [parseInt(root_folder_id), chosenFolders.map(f => f.id)]);
            
            if (checkFoldersRes.rows.length > 0) {
                return res.status(400).json({ 
                    status: "error", 
                    message: `⚠️ Cannot create portal: some of the selected folders (e.g. '${checkFoldersRes.rows[0].name}') are located outside of the selected Root Folder hierarchy.` 
                });
            }
        }

        const insertRes = await pool.query(`
            INSERT INTO portals (name, url, access, creation_date, last_sync, root_folder_id)
            VALUES ($1, '', $2, CURRENT_DATE, CURRENT_DATE, $3) RETURNING id;
        `, [name, access, root_folder_id ? parseInt(root_folder_id) : null]);
        
        const portal_id = insertRes.rows[0].id;        
        for (const f of chosenFolders) {
            await pool.query("INSERT INTO portal_folders (portal_id, folder_id, display_size) VALUES ($1, $2, $3);", [portal_id, f.id, f.size]);
        }
        const slug = generateSlug(name, portal_id);        
        const host = req.get('host');
        const protocol = req.protocol;
        const fullUrl = `${protocol}://${host}/portal/${slug}`;
        await pool.query("UPDATE portals SET slug = $1, url = $2 WHERE id = $3;", [slug, fullUrl, portal_id]);
        await updatePortalStats(portal_id);
        res.json({ status: "success", message: "Portal created successfully", portal_id });
    } catch (error) {
        console.error("Erreur add_portal:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// modifier un portail 
app.post('/update_portal/:portal_id', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        const pId = req.params.portal_id;
        const { name, url, access, files, size, creation_date, last_sync } = req.body;

        await pool.query(`
            UPDATE portals 
            SET name = $1, url = $2, access = $3, files = $4, size = $5, 
                creation_date = $6, last_sync = $7
            WHERE id = $8;
        `, [name, url, access, parseInt(files||0), size, creation_date || null, last_sync || null, pId]);
        
        res.json({ status: "success" });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

// suppr un portail
app.post('/delete_portal/:portal_id', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        const pId = req.params.portal_id;
        await pool.query("DELETE FROM portal_files WHERE portal_id = $1;", [pId]);
        const delRes = await pool.query("DELETE FROM portals WHERE id = $1 RETURNING name;", [pId]);
        
        if (delRes.rows.length > 0) {
            insightsClient.trackEvent({
            name: "portal deleted",
            properties: {
                portail_nom: delRes.rows[0].name,
                utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
            }
        });
            res.json({ status: "success", message: `Portal '${delRes.rows[0].name}' deleted successfully` });
        } else {
            res.status(404).json({ status: "error", message: "Portal not found" });
        }
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

// liste simplifiée des portails
app.get('/get_portals', loginRequiredJson, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name FROM portals ORDER BY name;");        
        const portalsFormatted = result.rows.map(p => ({
            id: p.id,
            name: p.name
        }));
        console.log(`Portails envoyés au modal : ${portalsFormatted.length}`); 
        res.json({ 
            status: "success",
            portals: portalsFormatted 
        });
    } catch (error) {
        console.error("Erreur dans /get_portals:", error);
        res.status(500).json({ status: "error", message: error.message, portals: [] });
    }
});

// assigner un fichier existant à un portail
app.post('/update_file_portal', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        const { filename, portal_id, folder_id } = req.body;
        if (!filename) return res.status(400).json({ status: "error", message: "Required file name" });

        // If folder_id is provided, overwrite the file's folder assignment
        if (folder_id && folder_id !== "none" && folder_id !== "") {
            await pool.query("UPDATE documents SET folder_id = $1 WHERE nom_fichier = $2;", [parseInt(folder_id), filename]);
        }

        // Check if portal has root_folder_id (Dossier Plafond)
        const portalCheck = await pool.query("SELECT root_folder_id, name FROM portals WHERE id = $1;", [portal_id]);
        if (portalCheck.rows.length > 0 && portalCheck.rows[0].root_folder_id) {
            const root_id = portalCheck.rows[0].root_folder_id;
            const portalName = portalCheck.rows[0].name;
            const fileCheck = await pool.query(`
                WITH RECURSIVE folder_tree AS (
                    SELECT id FROM folders WHERE id = $1
                    UNION
                    SELECT f.id FROM folders f
                    INNER JOIN folder_tree ft ON f.parent_id = ft.id
                )
                SELECT d.nom_fichier, f.name as folder_name 
                FROM documents d
                LEFT JOIN folders f ON f.id = d.folder_id
                WHERE d.nom_fichier = $2 
                  AND (d.folder_id IS NULL OR d.folder_id NOT IN (SELECT id FROM folder_tree));
            `, [root_id, filename]);
            
            if (fileCheck.rows.length > 0) {
                const folder_name = fileCheck.rows[0].folder_name || "Root";
                return res.status(400).json({ 
                    status: "error", 
                    message: `⚠️ Cannot assign to portal: This file is in folder '${folder_name}' which is outside of the portal's Root Folder hierarchy (${portalName}).` 
                });
            }
        }

        const exist = await pool.query("SELECT id FROM portal_files WHERE filename = $1 AND portal_id = $2;", [filename, portal_id]);
        if (exist.rows.length > 0) return res.json({ status: "success", message: "File already in portal" });
        const docRes = await pool.query(`
            SELECT nom_fichier, lien_telechargement, description, tags, date_ajout, date_event 
            FROM documents WHERE nom_fichier = $1;
        `, [filename]);
        if (docRes.rows.length === 0) return res.status(404).json({ status: "error", message: "File not found" });
        const doc = docRes.rows[0];
        const ext = require('path').extname(filename).toLowerCase();
        
        let file_type = "Other";
        if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) file_type = "Image";
        else if (['.mp4', '.mov', '.avi', '.wmv'].includes(ext)) file_type = "Video";
        else if (['.pdf'].includes(ext)) file_type = "PDF";
        else if (['.doc', '.docx'].includes(ext)) file_type = "Document";
        else if (['.xls', '.xlsx'].includes(ext)) file_type = "Spreadsheet";
        const blockBlobClient = containerClient.getBlockBlobClient(filename);
        const props = await blockBlobClient.getProperties();
        const size_bytes = props.contentLength || 0;

        await pool.query(`
            INSERT INTO portal_files (portal_id, filename, description, file_url, file_type, upload_date, size_bytes, size)
            VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7, $8);
        `, [portal_id, filename, doc.description || "No description", doc.lien_telechargement, file_type, doc.date_ajout, size_bytes, formatBytes(size_bytes)]);

        await updatePortalStats(portal_id);
        res.json({ status: "success" });
    } catch (error) {
        console.error("Erreur update_file_portal:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// liste des fichiers du portail
app.get('/get_portal_files/:portal_id', loginRequiredJson, async (req, res) => {
    try {
        const result = await pool.query("SELECT filename FROM portal_files WHERE portal_id = $1;", [req.params.portal_id]);
        res.json({ files: result.rows.map(r => r.filename) });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

// stats du portail
app.get('/portal/:portal_id/stats', loginRequiredJson, async (req, res) => {
    try {
        const stats = await updatePortalStats(req.params.portal_id);
        res.json({
            status: "success",
            files_count: stats.file_count,
            total_size: stats.total_size,
            total_bytes: "..." 
        });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.post('/remove_file_from_portal', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        const { filename, portal_id } = req.body;
        if (!filename || !portal_id) return res.status(400).json({ status: "error", message: "Missing params" });

        await pool.query("DELETE FROM portal_files WHERE filename = $1 AND portal_id = $2;", [filename, portal_id]);
        await updatePortalStats(portal_id);
        insightsClient.trackEvent({
            name: "remove_file_from_portal",
            properties: {
                fichier: filename,
                utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
            }
        });
        res.json({ status: "success" });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

// synchro les tailles des fichiers
app.get('/update_portal_files_sizes', loginRequiredJson, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, filename FROM portal_files;");
        const files = result.rows;
        let updatedCount = 0;

        for (let file of files) {
            const blockBlobClient = containerClient.getBlockBlobClient(file.filename);
            let sizeBytes = 0;
            
            try {
                const props = await blockBlobClient.getProperties();
                sizeBytes = props.contentLength;
            } catch (azureErr) {
                console.error(`Impossible de lire la taille pour ${file.filename}`);
            }
            const sizeDisplay = formatBytes(sizeBytes); 

            await pool.query(
                "UPDATE portal_files SET size_bytes = $1, size = $2 WHERE id = $3;",
                [sizeBytes, sizeDisplay, file.id]
            );
            updatedCount++;
        }
        const portalsRes = await pool.query("SELECT id FROM portals;");
        for (let portal of portalsRes.rows) {
            await updatePortalStats(portal.id);
        }

        res.json({
            status: "success", 
            message: `Updated sizes for ${updatedCount} files`
        });
    } catch (error) {
        console.error("Erreur update_portal_files_sizes:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// login au portail
app.get('/portal/:portal_id/login', async (req, res) => {
    try {
        const identifier = req.params.portal_id;
        const portal = await getPortalInfo(identifier);
        if (!portal) return res.status(404).send("Portal not found");
        const real_portal_id = portal.id;
        const slug = portal.slug || real_portal_id;

        if (req.session.user_email && req.session.user_email.endsWith('@pur.co')) {
            return res.redirect(`/portal/${slug}`);
        }
        if (req.session?.portal_access == real_portal_id && req.session?.portal_user_email && !req.query.force) {
            return res.redirect(`/portal/${slug}`);
        }
        res.render('portal_login.html', { portal_id: slug, portal_name: portal.name, error: null });
    } catch (error) {
        console.error("Erreur GET login:", error);
        res.status(500).send("Erreur serveur lors de l'affichage de la connexion");
    }
});

app.post('/portal/:portal_id/login', loginLimiter, upload.none(), async (req, res) => {
    try {
        const identifier = req.params.portal_id;
        const portal = await getPortalInfo(identifier);
        if (!portal) return res.status(404).send("Portal not found");
        const real_portal_id = portal.id;
        const slug = portal.slug || real_portal_id;
        const { email, password, reset_request, reset_email } = req.body;
        if (reset_request !== undefined) {
            const userRes = await pool.query("SELECT id FROM portal_users WHERE email = LOWER($1) AND portal_id = $2;", [reset_email, real_portal_id]);
            if (userRes.rows.length > 0) {
                const token = require('crypto').randomBytes(32).toString('hex');
                const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
                await pool.query("UPDATE portal_users SET reset_token = $1, reset_token_expiry = $2 WHERE email = $3 AND portal_id = $4;",
                    [token, expiry, reset_email, real_portal_id]);
                const resetUrl = `${req.protocol}://${req.get('host')}/portal/${slug}/reset_password/${token}`;
                await sendEmail(reset_email, "Resetting your password", `Click here: ${resetUrl}`);
                return res.render('portal_login.html', { portal_id: slug, portal_name: portal.name, error: "Reset email sent!" });
            }
        }
        
        const authorized = await checkPortalAccess(email, real_portal_id, password);
        if (authorized) {
            const user = await pool.query("SELECT id FROM portal_users WHERE email = $1 AND portal_id = $2;", [email, real_portal_id]);
            req.session.portal_user_id = user.rows[0].id;
            req.session.portal_user_email = email;
            req.session.portal_access = real_portal_id; 
            await pool.query("UPDATE portal_users SET last_login = NOW() WHERE id = $1;", [user.rows[0].id]);
            if (insightsClient) {
                insightsClient.trackEvent({
                    name: "portal_login_success",
                    properties: {
                        utilisateur: email,
                        portail: portal.name
                    }
                });

        }
            res.redirect(`/portal/${slug}`);
        } 
        else {
            res.render('portal_login.html', { portal_id: slug, portal_name: portal.name, error: "Incorrect email or password" });
        }
    } catch (error) {
        console.error("Erreur POST login:", error);
        res.render('portal_login.html', { portal_id: req.params.portal_id, portal_name: "Portal", error: "Une erreur interne est survenue. Veuillez réessayer." });
    }
});

// reset password
app.get('/portal/:portal_id/reset_password/:token', async (req, res) => {
    const identifier = req.params.portal_id;
    const { token } = req.params;
    
    const portal = await getPortalInfo(identifier);
    if (!portal) return res.status(404).send("Portail introuvable.");
    
    const result = await pool.query(
        "SELECT id, email FROM portal_users WHERE reset_token = $1 AND reset_token_expiry > NOW() AND portal_id = $2;",
        [token, portal.id]
    );

    if (result.rows.length === 0) return res.send("Lien invalide ou expiré.");
    
    const slug = portal.slug || portal.id;
    res.render('portal_reset_password.html', { portal_id: slug, token, email: result.rows[0].email });
});

app.post('/portal/:portal_id/reset_password/:token', upload.none(), async (req, res) => {
    const identifier = req.params.portal_id;
    const { token } = req.params;
    const { password, confirm_password } = req.body;

    if (password !== confirm_password) return res.send("Passwords do not match");

    const portal = await getPortalInfo(identifier);
    if (!portal) return res.status(404).send("Portail introuvable.");

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
        "UPDATE portal_users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE reset_token = $2 AND portal_id = $3;",
        [hashedPassword, token, portal.id]
    );

    const slug = portal.slug || portal.id;
    res.redirect(`/portal/${slug}/login`);
});

app.get('/portal/:portal_id/request_reset', async (req, res) => {
    try {
        const identifier = req.params.portal_id;
        const portal = await getPortalInfo(identifier);
        if (!portal) {
            req.flash('error', 'Portal not found');
            return res.redirect('/portals');
        }
        const slug = portal.slug || portal.id;
        res.render('portal_request_reset.html', { 
            portal_id: slug, 
            portal_name: portal.name 
        });
    } catch (error) {
        console.error("Erreur GET request_reset:", error);
        res.status(500).send("Server Error");
    }
});

app.post('/portal/:portal_id/request_reset', loginLimiter, upload.none(), async (req, res) => {
    const identifier = req.params.portal_id;
    const email = req.body.email ? req.body.email.toLowerCase().trim() : '';
    try {
        const portal = await getPortalInfo(identifier);
        if (!portal) {
            req.flash('error', 'Portal not found');
            return res.redirect('/portals');
        }
        const real_portal_id = portal.id;
        const slug = portal.slug || real_portal_id;
        // verif si l'utilisateur existe pour ce portail
        const userRes = await pool.query(
            "SELECT id FROM portal_users WHERE email = $1 AND portal_id = $2;",
            [email, real_portal_id]
        );
        if (userRes.rows.length > 0) {
            const token = require('crypto').randomBytes(32).toString('hex');
            const expiry = new Date();
            expiry.setHours(expiry.getHours() + 24);
            await pool.query(
                "UPDATE portal_users SET reset_token = $1, reset_token_expiry = $2 WHERE email = $3 AND portal_id = $4;",
                [token, expiry, email, real_portal_id]
            );
            const resetUrl = `${req.protocol}://${req.get('host')}/portal/${slug}/reset_password/${token}`;
            const subject = `Resetting your password - ${portal.name}`;
            const body = `Hello,

                          You have requested to reset your password for the ${portal.name} portal.

                          Please click the following link to set a new password:

                          ${resetUrl}

                          This link will expire in 24 hours.

                          Sincerely,
                          The Media Library Team`;

            const emailSent = await sendEmail(email, subject, body);

            if (emailSent) {
                req.flash('success', 'A reset email has been sent');
                return res.redirect(`/portal/${slug}/login`);
            } 
            else {
                req.flash('error', 'Error sending email');
            }
        } 
        else {
            req.flash('error', 'Email not found for this portal');
        }

        res.redirect(`/portal/${slug}/request_reset`);
    } catch (error) {
        console.error("Erreur request_reset:", error);
        req.flash('error', 'An error occurred');
        res.redirect(`/portal/${req.params.portal_id}/request_reset`);
    }
});

// logout
app.get('/logout_portal', (req, res) => {
    const pId = req.session.portal_access;
    if (req.session.user_email && req.session.user_email.endsWith('@pur.co')) {
        return res.redirect('/portals');
    }
    req.session.destroy();
    res.redirect(pId ? `/portal/${pId}/login` : '/');
});

app.post('/portal/:portal_id/logout', (req, res) => {
    const portal_id = req.params.portal_id;
    const userEmailToLog = req.session?.user_email || req.session?.portal_user_email || "Visiteur";
    if (req.session.user_email) {
        delete req.session.portal_user_id;
        delete req.session.portal_user_email;
        delete req.session.portal_access;
        req.session.save(() => {
            if (insightsClient) {
                insightsClient.trackEvent({
                    name: "logout_from_portal",
                    properties: {
                        portail: portal_id,
                        utilisateur: userEmailToLog 
                    }
                });
            }
            res.json({ status: "success", redirect_url: "/portals" });
        });
        return;
    }
    req.session.destroy((err) => {
        if (err) {
            console.error("Erreur destruction session:", err);
            return res.status(500).json({ status: "error" });
        }
        if (insightsClient) {
            insightsClient.trackEvent({
                name: "logout_from_portal",
                properties: {
                    portail: portal_id,
                    utilisateur: userEmailToLog 
                }
            });
        }
        res.json({ status: "success", redirect_url: `/portal/${portal_id}/login` });
    });
});

app.get("/get_portal_slug/:portal_id", async (req, res) => {
    try {
        const result = await pool.query("SELECT slug FROM portals WHERE id = $1;", [req.params.portal_id]);
        if (result.rows.length > 0 && result.rows[0].slug) {
            return res.json({ status: "success", slug: result.rows[0].slug });
        }
        res.status(404).json({ status: "error", message: "Slug not found" });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.get('/get_portal_url/:portal_id', loginRequiredJson, async (req, res) => {
    try {
        const portal_id = req.params.portal_id;
        if (!portal_id) return res.status(400).json({ status: "error", message: "ID manquant" });
        const result = await pool.query("SELECT slug FROM portals WHERE id = $1;", [portal_id]);
        const slug = (result.rows.length > 0 && result.rows[0].slug) ? result.rows[0].slug : portal_id;
        const host = req.get('host');
        const protocol = req.protocol;
        const portal_url = `${protocol}://${host}/portal/${slug}/login`;
        return res.json({ 
            status: "success", 
            url: portal_url 
        });
    } catch (error) {
        console.error("Erreur get_portal_url:", error);
        res.status(500).json({ status: "error", message: "Erreur serveur" });
    }
});

app.get('/admin/users', loginRequiredHtml, adminRequired, async (req, res) => {
    try {
        const usersResult = await pool.query(`
            SELECT pu.id, pu.email, pu.last_login, p.name as portal_name, p.id as portal_id
            FROM portal_users pu
            JOIN portals p ON pu.portal_id = p.id
            ORDER BY pu.email ASC;
        `);
        const portalsResult = await pool.query("SELECT id, name FROM portals ORDER BY name ASC;");
        res.render('admin_users.html', {
            users: usersResult.rows,
            portals: portalsResult.rows,
            is_admin: req.session.is_admin,
            username: req.session.username
        });
    } catch (error) {
        console.error("Erreur /admin/users:", error);
        res.status(500).send("Server error while loading the administration page.");
    }
});

// nouvelle user pour un portail
app.post('/admin/add_user', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const { email, password, portal_id } = req.body;
        if (!email || !password || !portal_id) {
            return res.status(400).json({ status: "error", message: "Email, password and portal are required." });
        }
        const safeEmail = email.toLowerCase().trim();
        // verifier que user existe deja pour ce portail
        const checkRes = await pool.query("SELECT id FROM portal_users WHERE email = $1 AND portal_id = $2;", [safeEmail, portal_id]);
        if (checkRes.rows.length > 0) {
            return res.status(400).json({ status: "error", message: "This user already has access to this portal." });
        }
        // hasher le mdp 
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            "INSERT INTO portal_users (email, password, portal_id) VALUES ($1, $2, $3);",
            [safeEmail, hashedPassword, portal_id]
        );
        if (typeof insightsClient !== 'undefined' && insightsClient) {
            insightsClient.trackEvent({
                name: "admin_user_added",
                properties: { email_cible: safeEmail, admin: req.session.user_email }
            });
        }
        res.json({ status: "success", message: "user created successfully" });
    } catch (error) {
        console.error("Erreur add_user:", error);
        res.status(500).json({ status: "error", message: "Error creating user" });
    }
});

// modifi mdp d'un user deja présent
app.post('/admin/update_password', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const { user_id, new_password } = req.body;
        if (!user_id || !new_password) {
            return res.status(400).json({ status: "error", message: "Username and new password required" });
        }

        const hashedPassword = await bcrypt.hash(new_password, 10);
        await pool.query("UPDATE portal_users SET password = $1 WHERE id = $2;", [hashedPassword, user_id]);
        
        res.json({ status: "success", message: "The password has been updated" });
    } catch (error) {
        console.error("Erreur update_password:", error);
        res.status(500).json({ status: "error", message: "Server error during update" });
    }
});

// suppr utilisateur
app.post('/admin/delete_user', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ status: "error", message: "Missing user ID" });

        await pool.query("DELETE FROM portal_users WHERE id = $1;", [user_id]);
        
        if (typeof insightsClient !== 'undefined' && insightsClient) {
            insightsClient.trackEvent({
                name: "admin_user_deleted",
                properties: { admin: req.session.user_email }
            });
        }
        res.json({ status: "success", message: "User access has been revoked" });
    } catch (error) {
        console.error("Erreur delete_user:", error);
        res.status(500).json({ status: "error", message: "Server error during deletion." });
    }
});


// ROUTE PROXY POUR LE TÉLÉCHARGEMENT ZIP 
const https = require('https'); 
app.get('/proxy_download', loginRequiredJson, (req, res) => {
    const fileUrl = req.query.url;
    const filename = req.query.filename || "file";
    if (!fileUrl) return res.status(400).send("URL missing");
    
    const startTime = Date.now();
    
    https.get(fileUrl, (response) => {
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        
        response.pipe(res);
        
        res.on('finish', () => {
            const duration = Date.now() - startTime;
            const sizeBytes = parseInt(response.headers['content-length'] || 0, 10);
            const speedMbps = sizeBytes > 0 && duration > 0 ? ((sizeBytes * 8) / (duration / 1000) / (1024 * 1024)).toFixed(2) : "0.00";
            
            if (insightsClient) {
                insightsClient.trackEvent({
                    name: "file_download",
                    properties: {
                        filename: filename,
                        duration_ms: duration,
                        size_bytes: sizeBytes,
                        speed_mbps: speedMbps,
                        utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
                    }
                });
            }
        });
    }).on('error', (err) => {
        console.error("Proxy download error:", err);
        res.status(500).send("Erreur de téléchargement du fichier.");
    });
});

// recup les sections et catégories uniques pour les filtres
app.get('/get_filters_data', loginRequiredJson, async (req, res) => {
    try {
        const sections = await pool.query("SELECT DISTINCT section FROM documents WHERE section IS NOT NULL AND section != '' ORDER BY section ASC;");
        const categories = await pool.query("SELECT DISTINCT category FROM documents WHERE category IS NOT NULL AND category != '' ORDER BY category ASC;");
        res.json({
            sections: sections.rows.map(r => r.section),
            categories: categories.rows.map(r => r.category)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// EXPORT COMPLET D'UN DOSSIER EN ZIP (AVEC ARBORESCENCE)
app.get('/api/export_folder_zip/:folder_id', loginRequiredJson, async (req, res) => {
    try {
        const targetFolderId = parseInt(req.params.folder_id);
        const foldersRes = await pool.query("SELECT id, name, parent_id FROM folders");
        const folders = foldersRes.rows;
        const folderMap = new Map();
        folders.forEach(f => folderMap.set(f.id, f));
        const targetFolder = folderMap.get(targetFolderId);
        if (!targetFolder) return res.status(404).json({ status: "error", message: "Dossier introuvable" });
        const descendants = [];
        const paths = new Map(); 

        function getDescendants(parentId, currentPath) {
            const children = folders.filter(f => f.parent_id === parentId);
            children.forEach(c => {
                const path = `${currentPath}/${c.name}`;
                paths.set(c.id, path);
                descendants.push(c.id);
                getDescendants(c.id, path); 
            });
        }

        paths.set(targetFolderId, targetFolder.name);
        descendants.push(targetFolderId);
        getDescendants(targetFolderId, targetFolder.name);
        const filesRes = await pool.query(
            "SELECT nom_fichier, lien_telechargement, folder_id FROM documents WHERE folder_id = ANY($1::int[])",
            [descendants]
        );
        const exportData = filesRes.rows.map(file => ({
            filename: file.nom_fichier,
            url: file.lien_telechargement,
            path: `${paths.get(file.folder_id)}/${file.nom_fichier}` 
        }));

        res.json({ status: "success", folderName: targetFolder.name, files: exportData });

    } catch (error) {
        console.error("Erreur export ZIP dossier:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// ajout ou retire un favori
app.post('/toggle_favorite', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        const filename = req.body.filename;
        const user_email = req.session.user_email || req.session.portal_user_email;
        if (!filename || !user_email) {
            return res.status(400).json({ status: "error", message: "Missing settings" });
        }
        const checkRes = await pool.query(
            "SELECT id FROM user_favorites WHERE user_email = $1 AND filename = $2;",
            [user_email, filename]
        );
        let is_favorited = false;
        if (checkRes.rows.length > 0) {
            await pool.query(
                "DELETE FROM user_favorites WHERE user_email = $1 AND filename = $2;",
                [user_email, filename]
            );
            is_favorited = false;
        } 
        else {
            await pool.query(
                "INSERT INTO user_favorites (user_email, filename) VALUES ($1, $2);",
                [user_email, filename]
            );
            is_favorited = true;
        }

        res.json({ status: "success", is_favorited: is_favorited });
    } catch (error) {
        console.error("Erreur toggle_favorite:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// recup liste de tous les fav de l'utilisateur actif
app.get('/my_favorites', loginRequiredJson, async (req, res) => {
    try {
        const user_email = req.session.user_email || req.session.portal_user_email;
        if (!user_email) return res.json({ status: "success", favorites: [] });
        const result = await pool.query(
            "SELECT filename FROM user_favorites WHERE user_email = $1;",
            [user_email]
        );
        const favoritesList = result.rows.map(row => row.filename);
        res.json({ status: "success", favorites: favoritesList });
    } catch (error) {
        console.error("Erreur my_favorites:", error);
        res.status(500).json({ status: "error", favorites: [] });
    }
});

// relier portail à un dossier
app.post('/link_portal_to_folder', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const { portal_id, folders, folder_ids, root_folder_id } = req.body;
        const raw = JSON.parse(folders || folder_ids || "[]");
        const chosen = raw.map(item =>
            (item && typeof item === 'object')
                ? { id: parseInt(item.id), size: item.size || 'standard' }
                : { id: parseInt(item), size: 'standard' }
        );

        if (root_folder_id) {
            // Check if any explicitly linked folder is outside of root_folder_id's subtree
            if (chosen.length > 0) {
                const checkFoldersRes = await pool.query(`
                    WITH RECURSIVE folder_tree AS (
                        SELECT id FROM folders WHERE id = $1
                        UNION
                        SELECT f.id FROM folders f
                        INNER JOIN folder_tree ft ON f.parent_id = ft.id
                    )
                    SELECT id, name FROM folders 
                    WHERE id = ANY($2::int[]) AND id NOT IN (SELECT id FROM folder_tree);
                `, [parseInt(root_folder_id), chosen.map(f => f.id)]);
                
                if (checkFoldersRes.rows.length > 0) {
                    return res.status(400).json({ 
                        status: "error", 
                        message: `⚠️ Cannot set this root folder: some of the selected folders (e.g. '${checkFoldersRes.rows[0].name}') are located outside of the selected Root Folder hierarchy. Please adjust your folder selection or root folder.` 
                    });
                }
            }

            // Check if any already linked files are outside of root_folder_id's subtree
            const checkFilesRes = await pool.query(`
                WITH RECURSIVE folder_tree AS (
                    SELECT id FROM folders WHERE id = $1
                    UNION
                    SELECT f.id FROM folders f
                    INNER JOIN folder_tree ft ON f.parent_id = ft.id
                )
                SELECT pf.filename, f.name as folder_name 
                FROM portal_files pf
                LEFT JOIN documents d ON d.nom_fichier = pf.filename
                LEFT JOIN folders f ON f.id = d.folder_id
                WHERE pf.portal_id = $2 
                  AND (d.folder_id IS NULL OR d.folder_id NOT IN (SELECT id FROM folder_tree));
            `, [parseInt(root_folder_id), portal_id]);

            if (checkFilesRes.rows.length > 0) {
                const offendingFile = checkFilesRes.rows[0].filename;
                const offendingFolder = checkFilesRes.rows[0].folder_name || "Root";
                return res.status(400).json({ 
                    status: "error", 
                    message: `⚠️ Cannot set this root folder: this portal already contains files located outside of this folder hierarchy (e.g. '${offendingFile}' in folder '${offendingFolder}'). Please remove these files from the portal first.` 
                });
            }
        }
        
        await pool.query("UPDATE portals SET root_folder_id = $1 WHERE id = $2;", [
            root_folder_id ? parseInt(root_folder_id) : null,
            portal_id
        ]);

        const existingRes = await pool.query("SELECT * FROM portal_folders WHERE portal_id = $1;", [portal_id]);
        const existingLayouts = new Map();
        existingRes.rows.forEach(row => {
            existingLayouts.set(row.folder_id, row);
        });
        await pool.query("DELETE FROM portal_folders WHERE portal_id = $1;", [portal_id]);
        for (const f of chosen) {
            const oldData = existingLayouts.get(f.id);
            
            if (oldData) {
                await pool.query(
                    `INSERT INTO portal_folders (portal_id, folder_id, display_size, col_span, row_span, position, custom_title, custom_title_color) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
                    [portal_id, f.id, f.size || 'standard', oldData.col_span, oldData.row_span, oldData.position, oldData.custom_title, oldData.custom_title_color]
                );
            } 
            else {
                await pool.query(
                    "INSERT INTO portal_folders (portal_id, folder_id, display_size) VALUES ($1, $2, $3);",
                    [portal_id, f.id, f.size || 'standard']
                );
            }
        }

        await updatePortalStats(portal_id);
        res.json({ status: "success", message: "Portal folders updated successfully" });
    } catch (error) {
        console.error("Erreur link_portal_to_folder:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.get('/portal_folders/:portal_id', loginRequiredJson, async (req, res) => {
    try {
        const portalRes = await pool.query("SELECT root_folder_id FROM portals WHERE id = $1;", [req.params.portal_id]);
        const root_folder_id = portalRes.rows.length > 0 ? portalRes.rows[0].root_folder_id : null;
        const result = await pool.query("SELECT folder_id, display_size FROM portal_folders WHERE portal_id = $1;", [req.params.portal_id]);
        res.json({ status: "success", folders: result.rows, root_folder_id: root_folder_id });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.post('/update_file_metadata', loginRequiredHtml, basicAdminRequired, async (req, res) => {
    try {
        let { original_filename, field, value } = req.body;
        if (!original_filename || !field) return res.status(400).json({ status: 'error', message: 'param missing' });
        if (field === 'filename') {
            const checkDocs = await pool.query("SELECT * FROM documents WHERE nom_fichier = $1", [value]);
            const checkPortal = await pool.query("SELECT * FROM portal_files WHERE filename = $1", [value]);
            
            if (checkDocs.rows.length > 0 || checkPortal.rows.length > 0) {
                return res.status(409).json({ status: 'error', message: 'This filename already exists.' });
            }
        }
        let dbFieldDoc = '';
        let dbFieldPortal = '';
        if (field === 'filename') { dbFieldDoc = 'nom_fichier'; dbFieldPortal = 'filename'; }
        else if (field === 'description') { dbFieldDoc = 'description'; dbFieldPortal = 'description'; }
        else if (field === 'section') { dbFieldDoc = 'section'; dbFieldPortal = null;}
        else if (field === 'category') { dbFieldDoc = 'category'; dbFieldPortal = null; }
        else if (field === 'tags') { dbFieldDoc = 'tags'; dbFieldPortal = null; }
        else if (field === 'date_ajout') { dbFieldDoc = 'date_ajout'; dbFieldPortal = 'upload_date'; }
        else if (field === 'date_event') { dbFieldDoc = 'date_event'; dbFieldPortal = null; }
        else if (field === 'metadata') { dbFieldDoc = 'metadata'; dbFieldPortal = null; }
        else { return res.status(400).json({ status: 'error', message: 'not editable' }); }
        if (value && typeof value === 'string' && value.trim() === '') {
            value = null;
        }
        else if (field === 'date_ajout' || field === 'date_event') {
            const dateParts = value.split('-');
            if (dateParts.length === 3) {
                if (dateParts[0].length <= 2) {
                    value = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
                }
            }
        }
        if (field === 'tags') {
            const tagsArray = value.split(',').map(t => t.trim()).filter(t => t.length > 0);
            await pool.query(`UPDATE documents SET tags = $1 WHERE nom_fichier = $2`, [JSON.stringify(tagsArray), original_filename]);
        } 
        else if (field === 'metadata') {
            let metadataObj = {};
            try {
                metadataObj = typeof value === 'string' ? JSON.parse(value) : value;
            } catch (e) {
                return res.status(400).json({ status: 'error', message: 'Invalid JSON for metadata' });
            }

            // Country/Region are mandatory for everyone except Super Admin (role 'admin'), who can bypass.
            const isSuperAdmin = (req.session.user_role === 'admin');
            if (!isSuperAdmin) {
                if (!metadataObj.country || String(metadataObj.country).trim() === "") {
                    return res.status(400).json({ status: 'error', message: "The 'Country' field is mandatory." });
                }
                if (!metadataObj.region || String(metadataObj.region).trim() === "") {
                    return res.status(400).json({ status: 'error', message: "The 'Region' field is mandatory." });
                }
            }

            await pool.query(`UPDATE documents SET metadata = $1 WHERE nom_fichier = $2`, [JSON.stringify(metadataObj), original_filename]);
        }
        else {
            await pool.query(`UPDATE documents SET ${dbFieldDoc} = $1 WHERE nom_fichier = $2`, [value, original_filename]);
        }
        if (dbFieldPortal) {
            await pool.query(`UPDATE portal_files SET ${dbFieldPortal} = $1 WHERE filename = $2`, [value, original_filename]);
        }

        res.json({ status: 'success', message: 'update success' });

    } catch (error) {
        console.error("Error /update_file_metadata :", error);
        res.status(500).json({ status: 'error', message: 'Error' });
    }
});

// ── Liens de partage groupés ─────────────────────────────────────────────────

app.post('/create_share_link', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        let filenames;
        try { filenames = JSON.parse(req.body.filenames || '[]'); } catch { filenames = []; }

        if (!Array.isArray(filenames) || filenames.length === 0) {
            return res.status(400).json({ status: 'error', message: 'No files specified.' });
        }

        const ph = filenames.map((_, i) => `$${i + 1}`).join(', ');
        const check = await pool.query(
            `SELECT nom_fichier FROM documents WHERE nom_fichier IN (${ph})`, filenames
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ status: 'error', message: 'No matching files found.' });
        }

        const token = crypto.randomBytes(18).toString('base64url').slice(0, 24);

        await pool.query(
            `INSERT INTO shared_links (token, filenames, created_by, expires_at)
             VALUES ($1, $2::jsonb, $3, NOW() + INTERVAL '30 days')`,
            [token, JSON.stringify(filenames), req.session.user_email || null]
        );

        const shareUrl = `${req.protocol}://${req.get('host')}/s/${token}`;
        res.json({ status: 'success', token, url: shareUrl });

    } catch (err) {
        console.error('create_share_link error:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Page publique du lien partagé — pas de login requis
app.get('/s/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const result = await pool.query(
            `SELECT filenames, created_at, expires_at FROM shared_links WHERE token = $1`, [token]
        );

        if (result.rows.length === 0) {
            return res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Link not found — PUR</title>
                <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f4f7;margin:0;}
                .box{text-align:center;padding:48px;background:white;border-radius:20px;box-shadow:0 8px 32px rgba(0,0,0,.1);}
                h2{color:#ef4444;margin-bottom:12px;}p{color:#64748b;}</style></head>
                <body><div class="box"><h2>🔗 Link not found</h2><p>This share link does not exist or has expired.</p></div></body></html>`);
        }

        const row = result.rows[0];
        if (new Date(row.expires_at) < new Date()) {
            return res.status(410).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Link expired — PUR</title>
                <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f4f7;margin:0;}
                .box{text-align:center;padding:48px;background:white;border-radius:20px;box-shadow:0 8px 32px rgba(0,0,0,.1);}
                h2{color:#f59e0b;margin-bottom:12px;}p{color:#64748b;}</style></head>
                <body><div class="box"><h2>⏰ Link expired</h2><p>This share link expired on ${new Date(row.expires_at).toLocaleDateString()}.</p></div></body></html>`);
        }

        const filenames = row.filenames;
        if (filenames.length === 0) return res.status(404).send('No files.');

        const ph2 = filenames.map((_, i) => `$${i + 1}`).join(', ');
        // 1. AJOUT DES COLONNES DE DATES DANS LA REQUÊTE SQL
        const filesResult = await pool.query(
            `SELECT nom_fichier AS name, lien_telechargement AS url, description, tags, date_ajout, date_event FROM documents WHERE nom_fichier IN (${ph2})`,
            filenames
        );

        const files = filesResult.rows;
        const createdAt = new Date(row.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        const expiresAt = new Date(row.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

        // Petit helper interne pour formater les dates proprement (JJ/MM/AAAA)
        const formatShareDate = (dateObj) => {
            if (!dateObj) return "Not specified";
            const d = new Date(dateObj);
            if (isNaN(d.getTime())) return "Not specified";
            const day = String(d.getDate()).padStart(2, '0');
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const year = d.getFullYear();
            return `${day}/${month}/${year}`;
        };

        const fileCards = files.map(f => {
            const ext = (f.name.split('.').pop() || '').toLowerCase();
            const isImg = ['jpg','jpeg','png','gif','webp','svg'].includes(ext);
            const isVideo = ['mp4','mov','webm','avi'].includes(ext);
            
            const safeName = f.name.replace(/"/g, '&quot;');
            const safeDesc = (f.description || '').replace(/"/g, '&quot;');
            
            let parsedTags = [];
            try {
                if (typeof f.tags === 'string') parsedTags = JSON.parse(f.tags);
                else if (Array.isArray(f.tags)) parsedTags = f.tags;
            } catch(e) {}
            const safeTags = JSON.stringify(parsedTags).replace(/"/g, '&quot;');

            const preview = isImg
                ? `<img src="${f.url}" alt="${safeName}" style="width:100%;height:175px;object-fit:cover;border-radius:12px 12px 0 0;">`
                : isVideo
                ? `<video src="${f.url}" style="width:100%;height:175px;object-fit:cover;border-radius:12px 12px 0 0;" muted></video>`
                : `<div style="height:175px;background:linear-gradient(135deg,#f0f4f7,#e8eef5);border-radius:12px 12px 0 0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#94a3b8;">
                     <span style="font-size:34px;">📄</span><span style="font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.05em;">${ext}</span>
                   </div>`;
                   
            // 2. AJOUT DES ATTRIBUTS DE DONNÉES SUR LA CARTE HTML
            return `<div style="background:white;border-radius:14px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06);transition:transform .2s,box-shadow .2s;cursor:pointer;"
                 onmouseover="this.style.transform='translateY(-4px)';this.style.boxShadow='0 12px 32px rgba(0,0,0,.1)'"
                 onmouseout="this.style.transform='';this.style.boxShadow='0 2px 8px rgba(0,0,0,.06)'"
                 data-url="${f.url}" 
                 data-name="${safeName}" 
                 data-desc="${safeDesc}" 
                 data-tags="${safeTags}" 
                 data-ext="${ext}"
                 data-added="${formatShareDate(f.date_ajout)}"
                 data-event="${formatShareDate(f.date_event)}"
                 onclick="openModal(this)">
              ${preview}
              <div style="padding:14px 16px;">
                <div style="font-weight:700;font-size:13.5px;color:#1e2533;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:8px;">${f.name}</div>
                ${f.description ? `<div style="font-size:12px;color:#64748b;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${f.description}</div>` : ''}
                
                <button onclick="event.stopPropagation(); const a = document.createElement('a'); a.href='${f.url}'; a.download='${safeName}'; document.body.appendChild(a); a.click(); document.body.removeChild(a);"
                   style="display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,#16677c,#0d4555);color:white;padding:8px 16px;border-radius:50px;font-size:12.5px;font-weight:700;text-decoration:none;border:none;cursor:pointer;margin-top:8px;">
                  ↓ Download
                </button>
              </div>
            </div>`;
        }).join('');

        res.send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Shared files — PUR</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Playfair+Display:wght@700;800&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:#f0f4f7;min-height:100vh;-webkit-font-smoothing:antialiased;}
    .banner{background:linear-gradient(120deg,#0d4555 0%,#16677c 55%,#1a8fa8 100%);padding:28px 40px;display:flex;align-items:center;justify-content:space-between;gap:20px;box-shadow:0 2px 16px rgba(13,69,85,.3);}
    .banner-title{font-family:'Playfair Display',serif;font-size:1.55rem;font-weight:800;color:white;letter-spacing:-.02em;}
    .banner-meta{color:rgba(255,255,255,.65);font-size:13px;margin-top:4px;}
    .badge{background:rgba(255,255,255,.15);color:white;border:1px solid rgba(255,255,255,.25);padding:8px 18px;border-radius:50px;font-size:13px;font-weight:700;white-space:nowrap;backdrop-filter:blur(6px);}
    .container{max-width:1100px;margin:0 auto;padding:36px 20px;}
    .meta-bar{background:white;border-radius:14px;border:1px solid #e2e8f0;padding:16px 24px;margin-bottom:28px;display:flex;gap:32px;flex-wrap:wrap;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.05);}
    .meta-item{display:flex;flex-direction:column;gap:2px;}
    .meta-label{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:#94a3b8;}
    .meta-value{font-size:14px;font-weight:700;color:#1e2533;}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:18px;}
    .footer{text-align:center;margin-top:40px;padding:20px;color:#94a3b8;font-size:13px;}
    .footer a{color:#16677c;font-weight:700;text-decoration:none;}
    
    /* Styles Modale */
    .modal-overlay { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(15, 23, 42, 0.85); z-index:9999; align-items:center; justify-content:center; padding:20px; opacity: 0; transition: opacity 0.3s ease;}
    .modal-overlay.active { display:flex; opacity: 1; }
    .modal-content { background:white; border-radius:16px; max-width:900px; width:100%; max-height:90vh; display:flex; flex-direction:column; overflow:hidden; position:relative; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);}
    .modal-close { position:absolute; top:12px; right:12px; background:#f1f5f9; border:none; border-radius:50%; width:36px; height:36px; cursor:pointer; font-size:16px; color:#475569; display:flex; align-items:center; justify-content:center; transition:background 0.2s; z-index:10;}
    .modal-close:hover { background:#e2e8f0; }
    .modal-media { background:#f8fafc; display:flex; justify-content:center; align-items:center; flex:1; overflow:hidden; min-height:40vh; position:relative; border-bottom: 1px solid #e2e8f0;}
    .modal-info { padding:24px; overflow-y:auto; max-height: 40vh; }
    .modal-tag { display:inline-block; background:#f1f5f9; color:#475569; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:600; margin: 0 6px 6px 0;}
    
    /* Styles Métadonnées Dates */
    .modal-meta-dates { display: flex; gap: 24px; margin-bottom: 20px; font-size: 13.5px; color: #475569; background: #f8fafc; padding: 12px 16px; border-radius: 8px; border: 1px solid #e2e8f0; }
    .meta-date-item { display: flex; align-items: center; gap: 6px; }

    @media(max-width:600px){.banner{flex-direction:column;text-align:center;padding:20px;}.meta-bar{gap:16px;}.modal-meta-dates{flex-direction:column; gap:8px;}}
  </style>
</head><body>
  <div class="banner">
    <div>
      <div class="banner-title">📎 Shared files</div>
      <div class="banner-meta">Shared via PUR Media Library</div>
    </div>
    <div class="badge">${files.length} file${files.length > 1 ? 's' : ''}</div>
  </div>
  <div class="container">
    <div class="meta-bar">
      <div class="meta-item"><span class="meta-label">Shared on</span><span class="meta-value">${createdAt}</span></div>
      <div class="meta-item"><span class="meta-label">Expires on</span><span class="meta-value">${expiresAt}</span></div>
      <div class="meta-item"><span class="meta-label">Files</span><span class="meta-value">${files.length}</span></div>
    </div>
    <div class="grid">${fileCards}</div>
    <div class="footer">Powered by <a href="/">PUR Media Library</a></div>
  </div>

  <div id="mediaModal" class="modal-overlay" onclick="if(event.target === this) closeModal()">
    <div class="modal-content">
      <button class="modal-close" onclick="closeModal()">✕</button>
      <div id="modalMediaContainer" class="modal-media"></div>
      <div class="modal-info">
        <h3 id="modalTitle" style="margin-bottom:8px;font-size:20px;color:#1e2533;font-weight:800;word-break:break-word;"></h3>
        <p id="modalDesc" style="font-size:14.5px;color:#64748b;margin-bottom:16px;line-height:1.6;"></p>
        
        <div class="modal-meta-dates">
          <div class="meta-date-item">
            <span style="font-size:16px;"></span> <strong>Added on:</strong> <span id="modalAddedDate"></span>
          </div>
          <div class="meta-date-item">
            <span style="font-size:16px;"></span> <strong>Event Date:</strong> <span id="modalEventDate"></span>
          </div>
        </div>

        <div id="modalTagsContainer" style="margin-bottom:20px;"></div>
        <a id="modalDownload" href="#" download style="display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,#16677c,#0d4555);color:white;padding:12px 24px;border-radius:50px;font-size:14px;font-weight:700;text-decoration:none;">
          ↓ Download original file
        </a>
      </div>
    </div>
  </div>

  <script>
    function openModal(el) {
      const url = el.getAttribute('data-url');
      const name = el.getAttribute('data-name');
      const desc = el.getAttribute('data-desc');
      const ext = el.getAttribute('data-ext');
      
      // Récupération des attributs de dates injectés
      const addedDate = el.getAttribute('data-added');
      const eventDate = el.getAttribute('data-event');
      
      let tags = [];
      try { 
        const tagsRaw = el.getAttribute('data-tags');
        if (tagsRaw) tags = JSON.parse(tagsRaw); 
      } catch(e) { console.error("Error parsing tags:", e); }

      document.getElementById('modalTitle').textContent = name;
      document.getElementById('modalDesc').textContent = desc || 'No description provided.';
      
      // Injection dynamique des dates dans les bons conteneurs
      document.getElementById('modalAddedDate').textContent = addedDate;
      document.getElementById('modalEventDate').textContent = eventDate;

      const dlBtn = document.getElementById('modalDownload');
      dlBtn.href = url;
      dlBtn.download = name;

      const tagsHtml = tags.length > 0 
        ? tags.map(t => \`<span class="modal-tag">\${t}</span>\`).join('')
        : '<span style="font-size:13px;color:#94a3b8;font-style:italic;">No tags</span>';
      document.getElementById('modalTagsContainer').innerHTML = tagsHtml;

      const mediaContainer = document.getElementById('modalMediaContainer');
      const isImg = ['jpg','jpeg','png','gif','webp','svg'].includes(ext);
      const isVideo = ['mp4','mov','webm','avi'].includes(ext);
      const isAudio = ['mp3','wav','ogg'].includes(ext);

      if (isImg) {
        mediaContainer.innerHTML = \`<img src="\${url}" style="max-width:100%;max-height:50vh;object-fit:contain;">\`;
      } else if (isVideo) {
        mediaContainer.innerHTML = \`<video src="\${url}" controls autoplay style="max-width:100%;max-height:50vh;outline:none;background:black;"></video>\`;
      } else if (isAudio) {
        mediaContainer.innerHTML = \`<audio src="\${url}" controls autoplay style="width:80%;"></audio>\`;
      } else if (ext === 'pdf') {
        mediaContainer.innerHTML = \`<iframe src="\${url}" style="width:100%;height:50vh;border:none;"></iframe>\`;
      } else if (['docx', 'pptx', 'xls', 'xlsx'].includes(ext)) {
        mediaContainer.innerHTML = \`<iframe src="https://view.officeapps.live.com/op/view.aspx?src=\${encodeURIComponent(url)}" style="width:100%;height:50vh;border:none;"></iframe>\`;
      } else {
        mediaContainer.innerHTML = \`<div style="display:flex;flex-direction:column;align-items:center;"><div style="font-size:64px;color:#94a3b8;">📄</div><div style="margin-top:12px;font-weight:800;color:#64748b;font-size:20px;">\${ext.toUpperCase()}</div></div>\`;
      }

      const modal = document.getElementById('mediaModal');
      modal.classList.add('active');
      document.body.style.overflow = 'hidden';
    }

    function closeModal() {
      const modal = document.getElementById('mediaModal');
      modal.classList.remove('active');
      document.getElementById('modalMediaContainer').innerHTML = ''; 
      document.body.style.overflow = 'auto';
    }
    
    document.addEventListener('keydown', function(event) {
      if (event.key === "Escape") {
        closeModal();
      }
    });
  </script>
</body></html>`);

    } catch (err) {
        console.error('share page error:', err);
        res.status(500).send('Server error.');
    }
});

// partage dossier entier
app.post('/api/share_folder/:folder_id', loginRequiredJson, async (req, res) => {
    try {
        const targetFolderId = parseInt(req.params.folder_id);
        const foldersRes = await pool.query("SELECT id, parent_id FROM folders");
        const folders = foldersRes.rows;
        const descendants = [];
        function getDescendants(parentId) {
            const children = folders.filter(f => f.parent_id === parentId);
            children.forEach(c => {
                descendants.push(c.id);
                getDescendants(c.id); 
            });
        }
        descendants.push(targetFolderId);
        getDescendants(targetFolderId);
        const filesRes = await pool.query(
            "SELECT nom_fichier FROM documents WHERE folder_id = ANY($1::int[])",
            [descendants]
        );
        const filenames = filesRes.rows.map(f => f.nom_fichier);
        if (filenames.length === 0) {
            return res.status(404).json({ status: "error", message: "This folder is empty." });
        }
        const token = crypto.randomBytes(18).toString('base64url').slice(0, 24);
        await pool.query(
            `INSERT INTO shared_links (token, filenames, created_by, expires_at)
             VALUES ($1, $2::jsonb, $3, NOW() + INTERVAL '30 days')`,
            [token, JSON.stringify(filenames), req.session.user_email || null]
        );

        const shareUrl = `${req.protocol}://${req.get('host')}/s/${token}`;
        res.json({ status: 'success', token, url: shareUrl, count: filenames.length });

    } catch (error) {
        console.error("Erreur share_folder:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

const processingFiles = new Set();
let cachedCantoToken = null;
let tokenExpirationTime = null;

async function getCantoToken() {
    if (
        cachedCantoToken &&
        tokenExpirationTime &&
        Date.now() < tokenExpirationTime - 300000
    ) {
        return cachedCantoToken;
    }
    const cantoDomain = process.env.CANTO_DOMAIN || "";
    
    // Canto OAuth server is on canto.de (EU), canto.global (Global) or canto.com (US), using the compatible token endpoint for Canto API v1
    const baseDomain = cantoDomain.includes("canto.de") ? "canto.de" : (cantoDomain.includes("canto.global") ? "canto.global" : "canto.com");
    const tokenUrl = `https://oauth.${baseDomain}/oauth/api/oauth2/compatible/token`;
    
    const params = new URLSearchParams();
    params.append("app_id", process.env.CANTO_APP_ID);
    params.append("app_secret", process.env.CANTO_APP_SECRET);
    params.append("grant_type", "client_credentials");
    
    const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
    });
    
    if (!response.ok) {
        throw new Error(`Failed to generate token: ${response.status}`);
    }
    
    const data = await response.json();
    cachedCantoToken = data.access_token;
    tokenExpirationTime = Date.now() + data.expires_in * 1000;
    
    return cachedCantoToken;
}

// ============================================
app.post('/api/webhook/canto_sync', express.json(), async (req, res) => {
    // 1. repond OK
    res.status(200).send('Webhook bien reçu');

    const payload = req.body || {};
    const canto_id = payload.id;
    const nom_fichier = payload.displayname;

    if (payload.secure_token !== 'motdepasse') return;
    if (!canto_id || !nom_fichier) return;

    if (processingFiles.has(canto_id)) {
        console.log(`[Auto-Sync] Doublon ignoré pour : ${nom_fichier}`);
        return; 
    }
    processingFiles.add(canto_id);

    try {
        const scheme = (payload.scheme || 'image').toLowerCase(); 
        console.log(`[Auto-Sync] Fichier détecté : ${nom_fichier} (Type: ${scheme})`);
        const cantoDomain = (process.env.CANTO_DOMAIN || "").replace('https://', '').replace('http://', '').replace(/\/$/, '');
        const cantoToken = await getCantoToken();
        console.log(`[DEBUG] Token généré (10 premiers char) : ${cantoToken.substring(0, 10)}...`);
        console.log(`[DEBUG] URL appelée : https://${cantoDomain}/api/v1/${scheme}/${canto_id}`);

        const detailResponse = await fetch(`https://${cantoDomain}/api/v1/${scheme}/${canto_id}`, {
            headers: { 
                'Authorization': `Bearer ${cantoToken}`,
                'User-Agent': 'App Canto Publishing', 
                'Accept': 'application/json'
            }
        });

        if (!detailResponse.ok) {
            const errorDetail = await detailResponse.text();
            console.error(`[DEBUG FATAL] Canto a refusé l'accès. Raison : ${errorDetail}`);
            throw new Error(`Erreur API Canto (${detailResponse.status}) pour le fichier ${nom_fichier} - Motif: ${errorDetail}`);
        }

        const assetData = await detailResponse.json();

        // 3. extraction lien téléchargement
        const download_url = (assetData.url && assetData.url.directUrlOriginal) ? assetData.url.directUrlOriginal : (assetData.url && assetData.url.download);
        if (!download_url) {
            console.log(`[Auto-Sync] Pas de lien direct pour ${nom_fichier}.`);
            return;
        }

        // 4. Dossiers
        let folder_id = null;
        if (assetData.relatedAlbums && assetData.relatedAlbums.length > 0) {
            const albumName = assetData.relatedAlbums[0].name;
            const folderRes = await pool.query("SELECT id FROM folders WHERE name = $1 LIMIT 1", [albumName]);
            if (folderRes.rows.length > 0) folder_id = folderRes.rows[0].id;
        }

        console.log(`[Auto-Sync] Aspiration de : ${nom_fichier} en cours...`);

        // 5. download depuis Canto
        const fileResponse = await fetch(download_url);
        if (!fileResponse.ok) throw new Error("Erreur téléchargement depuis Canto");
        const { Readable } = require('stream');
        const nodeStream = Readable.fromWeb(fileResponse.body);
        
        const ext = nom_fichier.split('.').pop().toLowerCase();
        
        const mimeTypes = {
            'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif', 
            'webp': 'image/webp', 'svg': 'image/svg+xml', 'bmp': 'image/bmp', 'ico': 'image/x-icon', 
            'tiff': 'image/tiff', 'tif': 'image/tiff', 'heic': 'image/heic', 'heif': 'image/heif', 
            'raw': 'image/x-panasonic-raw', 'cr2': 'image/x-canon-cr2', 'nef': 'image/x-nikon-nef', 'arw': 'image/x-sony-arw', 'dng': 'image/x-adobe-dng',
            'mp4': 'video/mp4', 'mov': 'video/quicktime', 'avi': 'video/x-msvideo', 'wmv': 'video/x-ms-wmv', 
            'flv': 'video/x-flv', 'mkv': 'video/x-matroska', 'webm': 'video/webm', 'm4v': 'video/x-m4v',
            'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg', 'm4a': 'audio/mp4', 'flac': 'audio/flac', 'aac': 'audio/aac',
            'pdf': 'application/pdf', 'txt': 'text/plain', 'csv': 'text/csv', 'rtf': 'application/rtf',
            'doc': 'application/msword', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'xls': 'application/vnd.ms-excel', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'ppt': 'application/vnd.ms-powerpoint', 'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'zip': 'application/zip', 'rar': 'application/vnd.rar', '7z': 'application/x-7z-compressed', 'tar': 'application/x-tar', 'gz': 'application/gzip'
        };

        const contentType = mimeTypes[ext] || fileResponse.headers.get('content-type') || 'application/octet-stream';

        const blockBlobClient = containerClient.getBlockBlobClient(nom_fichier);
        await blockBlobClient.uploadStream(nodeStream, 4 * 1024 * 1024, 20, {
            blobHTTPHeaders: { 
                blobContentType: contentType,
                blobContentDisposition: 'inline'
            }
        });
        const azureUrl = blockBlobClient.url;

        // 5.1 extraction metadonnées Canto 
        let tags = [];
        if (assetData.smartTags) tags = tags.concat(assetData.smartTags);
        if (assetData.tag) tags = tags.concat(typeof assetData.tag === 'string' ? assetData.tag.split(',') : assetData.tag);
        
        const description = assetData.description || "";
        const copyright = assetData.copyright || (assetData.additional && assetData.additional['Copyright']) || "";
        const author = assetData.ownerName || assetData.uploadedBy || (assetData.additional && assetData.additional['Author']) || "Canto Sync";
        const cooperative = assetData.additional && assetData.additional['Cooperative'] || "";
        const country = assetData.country || (assetData.additional && assetData.additional['Country']) || "";
        const project_name = assetData.additional && assetData.additional['Project Name'] || "";
        const region = assetData.additional && assetData.additional['Region'] || "";
        const wave = assetData.additional && assetData.additional['Wave'] || "";
        const farmer_consent = assetData.additional && assetData.additional['Farmer Consent'] || "";
        
        const extractArray = (field) => {
            if (!assetData.additional || !assetData.additional[field]) return [];
            const val = assetData.additional[field];
            return Array.isArray(val) ? val : [val];
        };

        const metadata = {
            author, copyright, cooperative, country, project_name, region, wave, farmer_consent,
            activity: extractArray('Activity'),
            challenge: extractArray('Challenge'),
            commodity: extractArray('Commodity'),
            ecosystem_service: extractArray('Ecosystem Service'),
            intervention_project_type: extractArray('Intervention / Projet Type').length > 0 
                ? extractArray('Intervention / Projet Type') 
                : extractArray('Intervention / Project Type')
        };

        // 6. enregistrement en BDD
        let rawDate = assetData.time || new Date(); 
        let date_ajout;
        try {
            if (typeof rawDate === 'string' && /^\d{8,17}$/.test(rawDate)) {
                const year = rawDate.slice(0, 4);
                const month = rawDate.slice(4, 6);
                const day = rawDate.slice(6, 8);
                date_ajout = `${year}-${month}-${day}`;
                
                if (isNaN(new Date(date_ajout).getTime())) {
                    date_ajout = new Date().toISOString().split('T')[0];
                }
            } 
            else {
                date_ajout = new Date(rawDate).toISOString().split('T')[0];
            }
        } catch (e) {
            console.error("[Auto-Sync] Error parsing Canto date, falling back to current date:", e.message);
            date_ajout = new Date().toISOString().split('T')[0];
        }
        await pool.query(`
            INSERT INTO documents (
                nom_fichier, description, folder_id, is_exclusive, 
                date_ajout, date_event, section, category, tags, 
                lien_telechargement, thumbnail_url, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (nom_fichier) DO NOTHING;
        `, [
            nom_fichier, description, folder_id, false, date_ajout, null, 
            "General", "General", JSON.stringify(tags), azureUrl, null, JSON.stringify(metadata)
        ]);

        // 7. creation de la miniature
        if (typeof generateAndUploadThumbnail === 'function') {
            generateAndUploadThumbnail(nom_fichier, containerClient, pool);
        }
        
        console.log(`[Auto-Sync] Terminé ! Fichier ${nom_fichier} est en ligne avec ses métadonnées.`);

    } catch (error) {
        console.error('[Auto-Sync] Erreur fatale:', error.message);
    } finally {
        setTimeout(() => {
            processingFiles.delete(canto_id);
        }, 10000);
    }
});

// Route d'administration pour les statistiques et logs d'audit locaux
app.get('/stats', loginRequiredHtml, basicAdminRequired, async (req, res) => {
    try {
        // 1. Get recent logs (last 100 actions)
        const recentLogsRes = await pool.query(`
            SELECT id, event_name, username, properties, 
                   to_char(timestamp, 'DD-MM-YYYY HH24:MI:SS') as formatted_date
            FROM activity_logs 
            ORDER BY timestamp DESC LIMIT 100;
        `);

        // 2. Count actions by type
        const statsByEventRes = await pool.query(`
            SELECT event_name, COUNT(*) as count 
            FROM activity_logs 
            GROUP BY event_name 
            ORDER BY count DESC;
        `);

        // 3. Count actions by user
        const statsByUserRes = await pool.query(`
            SELECT username, COUNT(*) as count 
            FROM activity_logs 
            GROUP BY username 
            ORDER BY count DESC LIMIT 10;
        `);

        // 4. Timeline data (last 7 days activity)
        const timelineRes = await pool.query(`
            SELECT to_char(timestamp, 'YYYY-MM-DD') as day, COUNT(*) as count 
            FROM activity_logs 
            WHERE timestamp > NOW() - INTERVAL '7 days'
            GROUP BY day 
            ORDER BY day ASC;
        `);

        // 5. Total counts of distinct actions
        const totalLogsRes = await pool.query("SELECT COUNT(*) FROM activity_logs;");
        const totalUploadsRes = await pool.query("SELECT COUNT(*) FROM activity_logs WHERE event_name ILIKE '%upload%' OR event_name ILIKE '%ajout%';");
        const totalDeletesRes = await pool.query("SELECT COUNT(*) FROM activity_logs WHERE event_name ILIKE '%delete%' OR event_name ILIKE '%suppr%';");

        // 6. Performance & Site Speed metrics (dynamically captured)
        const avgPageLoadRes = await pool.query("SELECT ROUND(AVG(CAST(properties->>'duration_ms' AS INTEGER))) as avg FROM activity_logs WHERE event_name = 'page_load';");
        const avgDownloadSpeedRes = await pool.query("SELECT ROUND(AVG(CAST(properties->>'speed_mbps' AS NUMERIC)), 2) as avg FROM activity_logs WHERE event_name = 'file_download';");
        const activeUsersTodayRes = await pool.query("SELECT COUNT(DISTINCT username) as count FROM activity_logs WHERE timestamp > CURRENT_DATE;");
        const pageLoadStatsRes = await pool.query("SELECT properties->>'path' as path, COUNT(*) as count, ROUND(AVG(CAST(properties->>'duration_ms' AS INTEGER))) as avg_duration FROM activity_logs WHERE event_name = 'page_load' GROUP BY path ORDER BY count DESC;");

        res.render('stats.html', {
            recentLogs: recentLogsRes.rows,
            statsByEvent: statsByEventRes.rows,
            statsByUser: statsByUserRes.rows,
            timelineData: JSON.stringify(timelineRes.rows),
            totalLogs: totalLogsRes.rows[0].count || 0,
            totalUploads: totalUploadsRes.rows[0].count || 0,
            totalDeletes: totalDeletesRes.rows[0].count || 0,
            avgPageLoad: avgPageLoadRes.rows[0].avg || 0,
            avgDownloadSpeed: avgDownloadSpeedRes.rows[0].avg || "0.00",
            activeUsersToday: activeUsersTodayRes.rows[0].count || 0,
            pageLoadStats: pageLoadStatsRes.rows,
            username: req.session.username,
            user_email: req.session.user_email,
            is_admin: req.session.is_admin,
            user_role: req.session.user_role
        });

    } catch (error) {
        console.error("Error loading stats page:", error);
        res.status(500).send("Internal Server Error");
    }
});

// ============================================


app.listen(PORT, () => {
    console.log(`serv Node.js démarré sur http://localhost:${PORT}`);
});