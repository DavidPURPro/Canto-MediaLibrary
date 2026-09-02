// npm install
// test en local : npx @dotenvx/dotenvx run -- node server.js

const { CryptoProvider } = require('@azure/msal-node');
const cryptoProvider = new CryptoProvider();
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
    max: 100,
    idleTimeoutMillis: 30000,
});

// table d'audit creee auto au startup si elle existe pas
pool.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        event_name VARCHAR(100) NOT NULL,
        username VARCHAR(100),
        properties JSONB DEFAULT '{}'::jsonb,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`).catch(err => console.error("Failed to create activity_logs table:", err));

const originalTrackEvent = insightsClient && typeof insightsClient.trackEvent === 'function' ? insightsClient.trackEvent.bind(insightsClient) : null;
insightsClient = {
    // transmet l’événement à application insights puis à postgresql
    // ignore la copie locale lorsqu’aucune identité fiable n’est disponible
    trackEvent: function(telemetry) {
        if (originalTrackEvent) {
            try { originalTrackEvent(telemetry); } catch (e) {
                console.error("[Local Analytics] Failed to execute original AppInsights trackEvent:", e.message);
            }
        } else {
            console.log(`[Local Analytics] Event: ${telemetry.name}`, telemetry.properties);
        }

        // propriétés jointes à l’événement ou au fichier traité
        const properties = telemetry.properties || {};
        // identité utilisée pour enregistrer l’activité
        const username = properties.utilisateur || properties.user || properties.admin || null;

        if (!username) {
            console.warn(`[Audit] Event "${telemetry.name}" not saved: no authenticated user.`);
            return;
        }

        // enregistre l’événement de télémétrie dans la table d’audit
        pool.query(`
            INSERT INTO activity_logs (event_name, username, properties)
            VALUES ($1, $2, $3);
        `, [telemetry.name, username, JSON.stringify(properties)])
        .catch(err => console.error("Failed to save activity log to DB:", err.message));
    }
};

// module qui lit les fichiers et les formulaires envoyés au serveur
const multer = require('multer');
// outil qui nettoie les noms avant la création des blobs
const sanitize = require('sanitize-filename');
// connexion principale au compte azure blob storage
const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
// conteneur azure qui stocke les fichiers et les miniatures
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

            // propriétés jointes à l’événement ou au fichier traité
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
    // indique à multer qu’aucune suppression locale n’est nécessaire
    _removeFile: function (req, file, cb) { cb(null); }
};

// vérifie l’extension avant de laisser multer accepter le fichier
// renvoie une erreur si l’extension figure dans la liste interdite
const fileFilter = (req, file, cb) => {
    // extension du fichier actuellement traité
    const ext = path.extname(file.originalname).toLowerCase();
    // liste des extensions refusées pendant un upload
    const forbidden_extensions = [];

    if (forbidden_extensions.includes(ext)) {
        return cb(new Error(`Extension_Error:${ext}`));
    }
    cb(null, true);
};

// middleware multer utilisé pour les uploads de fichiers
const uploadStream = multer({ storage: AzureStreamStorage, fileFilter: fileFilter });
// middleware multer utilisé pour les formulaires sans stockage local
const upload = multer();

// outil qui chiffre et compare les mots de passe des clients
const bcrypt = require('bcryptjs');
// bibliothèque utilisée pour la connexion microsoft entra
const msal = require('@azure/msal-node');
// client utilisé pour appeler les api microsoft graph
const { Client } = require('@microsoft/microsoft-graph-client');
// ajoute fetch aux bibliothèques microsoft qui en ont besoin
require('isomorphic-fetch');
// outil utilisé pour générer des jetons aléatoires
const crypto = require('crypto');

// configuration de l’application microsoft confidentielle
const msalConfig = {
    auth: {
        clientId: process.env.AZURE_AD_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}`,
        clientSecret: process.env.AZURE_AD_CLIENT_SECRET

    }
};
// client microsoft utilisé pour les appels applicatifs graph
const cca = new msal.ConfidentialClientApplication(msalConfig);

// environnement nunjucks utilisé pour les templates et leurs filtres
const env = nunjucks.configure('templates', {
    autoescape: true,
    express: app,
    watch: true
});

// module qui crée et lit les sessions express
const session = require('express-session');

// module qui limite le nombre de tentatives de connexion
const rateLimit = require('express-rate-limit');

// active la lecture des corps de requête au format json
app.use(express.json());
// active la lecture des formulaires envoyés par le navigateur
app.use(express.urlencoded({ extended: true }));
// fait confiance au premier proxy placé devant express
app.set('trust proxy', 1);
// crée la session utilisée par les comptes internes et les comptes portail
app.use(session({
    secret: process.env.SECRET_KEY || 'super_secret_key_de_secours',
    resave: false,
    saveUninitialized: false,
    name: 'portal_session',
    rolling: true,
    cookie: { secure: true // à mettre à true en prod, false sinon
        , httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));


// récupère l’identité gardée au début de la requête
// utilise ensuite la session comme solution de repli
function getAuditUser(req) {
    return req.auditUser || req.session?.user_email || req.session?.portal_user_email || null;
}

// mémorise l’utilisateur et mesure le temps des pages importantes
// envoie la mesure après la fin de la réponse
app.use((req, res, next) => {
    // heure de départ utilisée pour calculer la durée
    const start = Date.now();
    req.auditUser = req.session?.user_email || req.session?.portal_user_email || null;

    // envoie la mesure de durée quand la réponse est terminée
    res.on('finish', () => {
        if (req.method !== 'GET' ||
            (req.path !== '/index' && req.path !== '/stats' && !req.path.startsWith('/portal'))) {
            return;
        }

        // élément actuellement traité pour user
        const user = getAuditUser(req);
        if (!user) return;

        insightsClient.trackEvent({
            name: "page_load",
            properties: {
                path: req.path,
                duration_ms: Date.now() - start,
                user: user
            }
        });
    });

    next();
});

// limiteur appliqué aux connexions pour réduire les essais abusifs
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: "Too many login attempts. Please wait 15 minutes before trying again.",
    standardHeaders: true,
    legacyHeaders: false,
    // renvoie une erreur json quand trop de connexions sont tentées
    handler: (req, res, next, options) => {
        if (req.path.includes('/login')) {
            // identifiant du portail actuellement traité
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

// active les messages temporaires affichés après une redirection
app.use(flash());

// rend la session et les messages flash disponibles dans les templates
app.use((req, res, next) => {
    res.locals.session = {
        // lit une valeur de session depuis un template
        get: function(key) { return req.session ? req.session[key] : null; }
    };
    // transforme les messages flash au format attendu par nunjucks
    res.locals.get_flashed_messages = function(withCategories = false) {
        // messages temporaires à transmettre au prochain affichage
        const flashes = req.flash();
        // liste utilisée pour messages
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


// configuration microsoft utilisée pour la connexion interactive
const authMsalConfig = {
    auth: {
        clientId: process.env.AZURE_AD_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}`
    }
};
// client microsoft utilisé pour la connexion pkce de l’utilisateur
const pca = new msal.PublicClientApplication(authMsalConfig);

// construit dans nunjucks le chemin d’un fichier statique
env.addGlobal('url_for', function(type, kwargs) {
    if (type === 'static') {
        return '/static/' + kwargs.filename;
    }
    return '/';
});

// expose un objet session minimal aux templates nunjucks
env.addGlobal('session', {
    // lit une valeur de session en tenant compte de la requête
    get: function(key, req) {
        return "";
    }
});

// retourne la plus grande valeur d’un tableau dans un template
env.addFilter('max', function(array) {
    if (!array || array.length === 0) return 0;
    return Math.max(...array);
});

// retourne la plus petite valeur d’un tableau dans un template
env.addFilter('min', function(array) {
    if (!array || array.length === 0) return 0;
    return Math.min(...array);
});

// calcule les initiales du bouton profil à partir de l’email
// ignore le préfixe ext- des comptes externes (ext-prenom.nom@pur.co -> PN)
function getInitialsFromEmail(email) {
    if (!email || typeof email !== 'string') return 'C';

    let localPart = email.split('@')[0] || '';
    if (localPart.toLowerCase().startsWith('ext-')) {
        localPart = localPart.slice(4);
    }

    const parts = localPart.split('.').filter(part => part && part.length > 0);
    const firstInitial = parts[0] ? parts[0].charAt(0).toUpperCase() : '';
    const lastInitial = parts[1] ? parts[1].charAt(0).toUpperCase() : '';
    return (firstInitial + lastInitial) || 'C';
}

env.addGlobal('get_initials', getInitialsFromEmail);
env.addFilter('get_initials', getInitialsFromEmail);

// formate une date complète pour les templates nunjucks
env.addFilter('date', function(dateObj) {
    if (!dateObj) return "";
    // objet date utilisé pendant le formatage
    const d = new Date(dateObj);
    // jour extrait de la date
    const day = String(d.getDate()).padStart(2, '0');
    // mois extrait de la date
    const month = String(d.getMonth() + 1).padStart(2, '0');
    // année extraite de la date
    const year = d.getFullYear();
    // heure extraite de la date
    const hours = String(d.getHours()).padStart(2, '0');
    // minutes extraites de la date
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
});

// envoie un email avec microsoft graph depuis le compte configuré
// retourne false si le jeton ou l’envoi échoue
async function sendEmail(toEmail, subject, body) {
    try {
        // jeton utilisé pour token response
        const tokenResponse = await cca.acquireTokenByClientCredential({
            scopes: ["https://graph.microsoft.com/.default"],
        });
        // client microsoft graph utilisé pour les appels de cette opération
        const client = Client.init({
            authProvider: (done) => done(null, tokenResponse.accessToken),
        });
        // contenu de l’email envoyé à microsoft graph
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

// vérifie qu’un email appartient bien au portail demandé
// compare aussi le mot de passe lorsque celui-ci est fourni
async function checkPortalAccess(email, portalId, password = null) {
    // lignes renvoyées par la requête sql en cours
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

// charge le root folder et tous ses descendants avec une requête récursive
// n’ajoute jamais les parents ou les folders situés hors de cette branche
async function getFolderSubtree(rootFolderId) {
    if (!rootFolderId) return [];
    // lignes renvoyées par la requête sql en cours
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

// renvoie uniquement l’arbre situé sous le root folder du portail
// vérifie d’abord que la session peut consulter ce portail
app.get('/portal/:portal_id/tree', loginRequiredHtml, async (req, res) => {
    try {
        // identifiant ou slug utilisé pour retrouver le portail
        const identifier = req.params.portal_id;
        // données des portails renvoyées par la requête sql
        const portalRes = await pool.query("SELECT * FROM portals WHERE id::text = $1 OR slug = $1;", [identifier]);
        if (portalRes.rows.length === 0) return res.status(404).json({ status: "error" });
        // ligne de base contenant le portail demandé
        const portalRow = portalRes.rows[0];
        // indique si une session interne est connectée
        const isGlobalAuth = !!req.session.user_email;
        // indique si la session client ouvre le bon portail
        const isAuthorizedPortalUser = !!req.session.portal_user_email && (req.session.portal_access == portalRow.id);
        if (!isGlobalAuth && !isAuthorizedPortalUser) return res.status(403).json({ status: "error" });
        if (!portalRow.root_folder_id) {
            return res.json({ status: "success", tree: [], root_id: null });
        }
        // liste plate du root folder et de ses descendants
        const flatTree = await getFolderSubtree(portalRow.root_folder_id);
        // table de correspondance utilisée pour map
        const map = {};
        flatTree.forEach(f => map[f.id] = { ...f, subfolders: [] });
        // relie chaque folder de la liste plate à son parent
        flatTree.forEach(f => {
            if (f.parent_id && map[f.parent_id]) map[f.parent_id].subfolders.push(map[f.id]);
        });

        res.json({ status: "success", tree: map[portalRow.root_folder_id] || null, root_id: portalRow.root_folder_id });
    } catch (error) {
        console.error("Erreur /portal/:portal_id/tree:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// rend le dossier static accessible au navigateur
app.use('/static', express.static(path.join(__dirname, 'static')));


// redirige la racine du site vers la page principale
app.get('/', loginRequiredHtml, (req, res) => {
    res.redirect('/index');
});

// crée la miniature d’un fichier puis l’envoie dans azure blob storage
// utilise une icône simple lorsque le format ne peut pas être converti
async function generateAndUploadThumbnail(filename, containerClient, pool) {
    // extension du fichier actuellement traité
    const ext = path.extname(filename).toLowerCase();

    // extensions qui nécessitent une miniature visuelle
    const visualExts = ['.ai', '.eps', '.psd', '.tiff', '.tif', '.arw', '.cr2', '.nef', '.dng'];
    // extensions de fichiers texte ou de données
    const dataExts = ['.srt', '.kml', '.txt'];

    if (dataExts.includes(ext)) {
        // adresse utilisée pour icon url
        let iconUrl = '/static/icons/default.png';
        if (ext === '.srt') iconUrl = '/static/icons/subtitle.png';
        if (ext === '.kml') iconUrl = '/static/icons/map.png';

        await pool.query("UPDATE documents SET thumbnail_url = $1 WHERE nom_fichier = $2", [iconUrl, filename]);
        await pool.query("UPDATE portal_files SET thumbnail_url = $1 WHERE filename = $2", [iconUrl, filename]);
        return;
    }

    if (!visualExts.includes(ext)) return;

    // chemin temporaire du fichier source à convertir
    const tmpOriginal = path.join(os.tmpdir(), filename);
    // nom de fichier utilisé pour thumb filename
    const thumbFilename = `thumb_${filename}.jpg`;
    // chemin temporaire de la miniature produite
    const tmpThumb = path.join(os.tmpdir(), thumbFilename);

    try {
        // client azure qui agit sur le blob du fichier courant
        const blockBlobClient = containerClient.getBlockBlobClient(filename);
        // données reçues pour download response
        const downloadResponse = await blockBlobClient.download(0);
        await pipeline(downloadResponse.readableStreamBody, fs.createWriteStream(tmpOriginal));

        // attend la fin de la conversion imagemagick
        await new Promise((resolve, reject) => {
            // conversion imagemagick préparée pour la miniature
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

        // client utilisé pour thumb blob client
        const thumbBlobClient = containerClient.getBlockBlobClient(thumbFilename);
        await thumbBlobClient.uploadFile(tmpThumb, {
            blobHTTPHeaders: { blobContentType: 'image/jpeg' }
        });

        // adresse utilisée pour thumb url
        const thumbUrl = thumbBlobClient.url;

        await pool.query("UPDATE documents SET thumbnail_url = $1 WHERE nom_fichier = $2", [thumbUrl, filename]);
        await pool.query("UPDATE portal_files SET thumbnail_url = $1 WHERE filename = $2", [thumbUrl, filename]);

    } catch (error) {
        // icône utilisée pour error icon
        const errorIcon = '/static/icons/broken_file.png';
        await pool.query("UPDATE documents SET thumbnail_url = $1 WHERE nom_fichier = $2", [errorIcon, filename]);
    } finally {
        if (fs.existsSync(tmpOriginal)) fs.unlinkSync(tmpOriginal);
        if (fs.existsSync(tmpThumb)) fs.unlinkSync(tmpThumb);
    }
}

// affiche la page principale en réutilisant le traitement de la racine
// garde les mêmes paramètres de filtre, de tri et de pagination
app.get('/index', loginRequiredHtml, (req, res) => {
    res.render('page_canto.html', {
        username: req.session.username,
        user_email: req.session.user_email,
        is_admin: req.session.is_admin,
        user_role: req.session.user_role
    });
});

// calcule le rôle interne à partir des groupes microsoft entra
// retourne viewer si aucun groupe autorisé ne correspond
async function getUserRole(accessToken) {
    // identifiant entra du groupe des admins
    const adminGroupId = process.env.ADMIN_GROUP_ID;
    // identifiant entra du groupe des basic admins
    const moderatorGroupId = process.env.MODERATOR_GROUP_ID;
    // identifiant entra du groupe des uploaders
    const uploaderGroupId = process.env.UPLOADER_GROUP_ID;
    try {
        // client microsoft graph utilisé pour les appels de cette opération
        const client = Client.init({ authProvider: (done) => done(null, accessToken) });
        // données reçues pour response
        const response = await client.api('/me/memberOf').select('id').get();
        if (response.value && response.value.length > 0) {
            // identifiants des groupes entra de l’utilisateur
            const userGroupIds = response.value.map(group => group.id);
            if (adminGroupId && userGroupIds.includes(adminGroupId)) return 'admin';
            if (moderatorGroupId && userGroupIds.includes(moderatorGroupId)) return 'basic_admin';
            if (uploaderGroupId && userGroupIds.includes(uploaderGroupId)) return 'uploader';
        }
        return 'viewer';
    } catch (e) {
        console.warn("Erreur Graph API (Role Check):", e.message);
        return 'viewer';
    }
}

// autorise la page d’upload aux admins et aux uploaders
// redirige les autres utilisateurs vers l’accueil
function uploadAccessRequired(req, res, next) {
    // rôle attribué à l’utilisateur connecté
    const role = req.session.user_role;
    if (role === 'admin' || role === 'basic_admin' || role === 'uploader') {
        return next();
    }
    if (req.method === 'GET' && !req.headers.accept?.includes('application/json')) {
        return res.redirect('/');
    }
    return res.status(403).json({ status: "error", message: "Access Denied. Uploaders and Admins only." });
}


// protège une page html avec la session interne ou la session portail
// redirige vers la bonne page de connexion si la session manque
function loginRequiredHtml(req, res, next) {
    if (req.path.startsWith('/portal/')) {
        // indique si la session appartient à un compte interne
        const isInternalUser = req.session.user_email && req.session.user_email.endsWith('@pur.co');
        if (isInternalUser) {
            return next();
        }
        if (!req.session.portal_user_email) {
            // adresse utilisée pour url parts
            const urlParts = req.path.split('/');
            // identifiant de portail utilisé pour extracted portal id
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

// protège une route json avec la session interne
// renvoie une erreur 401 au lieu de faire une redirection
function loginRequiredJson(req, res, next) {
    if (!req.session.user_email) return res.status(401).json({ error: "Unauthorized" });
    next();
}

// autorise les requêtes json des comptes internes et des comptes portail
// laisse les contrôles de périmètre aux routes qui renvoient les fichiers
function portalOrInternalRequiredJson(req, res, next) {
    if (!req.session.user_email && !req.session.portal_user_email) {
        return res.status(401).json({ status: "error", error: "Unauthorized" });
    }
    next();
}

// vérifie que la session possède le rôle admin
// bloque la requête avec une redirection ou une erreur 403
function adminRequired(req, res, next) {
    if (!req.session || !req.session.is_admin) {
        if (req.method === 'GET' && !req.headers.accept?.includes('application/json')) {
            return res.redirect('/');
        }
        return res.status(403).json({ status: "error", message: "Admin Access Required" });
    }
    next();
}

// autorise les rôles admin et basic_admin
// bloque les autres rôles avant l’exécution de la route
function basicAdminRequired(req, res, next) {
    // rôle attribué à l’utilisateur connecté
    const role = req.session.user_role;
    if (role !== 'admin' && role !== 'basic_admin') {
        if (req.method === 'GET' && !req.headers.accept?.includes('application/json')) {
            return res.redirect('/');
        }
        return res.status(403).json({ status: "error", message: "Moderator or Admin Access Required" });
    }
    next();
}

// autorise les admins, basic admins et uploaders
// utilise ce contrôle pour les actions ouvertes au dépôt
function uploaderOrAdminRequired(req, res, next) {
    // rôle attribué à l’utilisateur connecté
    const role = req.session.user_role;
    if (role !== 'admin' && role !== 'basic_admin' && role !== 'uploader') {
        return res.status(403).json({ status: "error", message: "Admin, Moderator or Uploader Access Required" });
    }
    next();
}

// affiche la page de connexion microsoft pour un utilisateur interne
app.get('/privacy', (req, res) => {
    res.render('privacy.html');
});

app.get('/login', (req, res) => {
    if (req.session.user_email) return res.redirect('/');
    res.render('login.html');
});

// démarre la connexion microsoft avec le mécanisme pkce
// garde le vérificateur en session pour contrôler le retour
app.get('/start_auth', async (req, res) => {
    req.session.nextUrl = req.query.next || '/';

    try {
        // codes pkce utilisés pour sécuriser la connexion microsoft
        const { challenge, verifier } = await cryptoProvider.generatePkceCodes();
        req.session.pkceVerifier = verifier;

        // adresse utilisée pour auth code url parameters
        const authCodeUrlParameters = {
            scopes: ["User.Read", "GroupMember.Read.All"],
            redirectUri: process.env.REDIRECT_URI,
            codeChallenge: challenge,
            codeChallengeMethod: "S256"
        };

        // adresse utilisée pour response url
        const responseUrl = await pca.getAuthCodeUrl(authCodeUrlParameters);
        res.redirect(responseUrl);

    } catch (error) {
        console.error("Erreur critique dans start_auth:", error);
        res.redirect('/login');
    }
});

// échange le code microsoft contre les jetons de connexion
// vérifie le domaine puis crée la session et le rôle interne
app.get('/getAToken', async (req, res) => {
    try {
        // jeton utilisé pour token request
        const tokenRequest = {
            code: req.query.code,
            scopes: ["User.Read", "GroupMember.Read.All"],
            redirectUri: process.env.REDIRECT_URI,
            codeVerifier: req.session.pkceVerifier
        };

        // données reçues pour response
        const response = await pca.acquireTokenByCode(tokenRequest);
        // adresse email utilisée pour email
        const email = (response.account.username || response.account.name || "").toLowerCase();
        // domaine email autorisé pour la connexion interne
        const allowedDomain = (process.env.ALLOWED_DOMAIN || "pur.co").toLowerCase();

        if (!email.endsWith(`@${allowedDomain}`)) {
            req.session.destroy();
            return res.status(403).send(`Access denied: only the domain @${allowedDomain} is authorized.`);
        }

        // rôle attribué à l’utilisateur connecté
        const role = await getUserRole(response.accessToken);
        req.session.access_token = response.accessToken;
        req.session.user_email = email;
        req.session.username = email.split('@')[0];

        // prénom renvoyé par microsoft entra
        const given_name = response.idTokenClaims?.given_name || "";
        // nom de famille renvoyé par microsoft entra
        const family_name = response.idTokenClaims?.family_name || "";
        // nom complet conservé dans la session
        const fullName = (given_name && family_name) ? `${given_name} ${family_name}` : (response.account.name || response.account.username || "");
        req.session.user_fullname = fullName;

        req.session.user_role = role;
        req.session.is_admin = (role === 'admin');
        if (insightsClient) {
                insightsClient.trackEvent({
                    name: "login_success",
                    properties: {
                        user: email
                    }
                });
        }
        // adresse utilisée pour next url
        const nextUrl = req.session.nextUrl || '/';
        delete req.session.nextUrl;

        res.redirect(nextUrl);

    } catch (error) {
        console.error("Erreur getAToken:", error);
        res.redirect('/login');
    }
});

// journalise la déconnexion puis détruit la session interne
// redirige ensuite vers la déconnexion microsoft
app.get('/logout', (req, res) => {
    // adresse email utilisée pour user email to log
    const userEmailToLog = getAuditUser(req);
    // termine la déconnexion après destruction de la session
    req.session.destroy((err) => {
        insightsClient.trackEvent({
            name: "logout",
            properties: {
                user: userEmailToLog
            }
        });
        // information réseau utilisée pour domaine
        const domaine = process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : `${req.protocol}://${req.get('host')}`;
        // adresse utilisée pour post logout uri
        const postLogoutUri = `${domaine}/login`;
        // adresse de retour encodée pour la déconnexion microsoft
        const postLogoutUriEncoded = encodeURIComponent(postLogoutUri);
        // adresse microsoft utilisée pour terminer la déconnexion
        const aadLogout = `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${postLogoutUriEncoded}`;
        res.redirect(aadLogout);
    });
});

// convertit un nombre d’octets en une taille plus facile à lire
// choisit automatiquement les octets, ko, mo ou go
function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0Bytes";
    if (bytes >= 1024 ** 3) return (bytes / (1024 ** 3)).toFixed(2) + "GB";
    if (bytes >= 1024 ** 2) return (bytes / (1024 ** 2)).toFixed(2) + "MB";
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + "KB";
    return bytes + "Bytes";
}

// transforme le nom du portail en texte utilisable dans une url
// ajoute l’identifiant pour garder une adresse unique
function generateSlug(name, id) {
    // nom de fichier sécurisé avant son utilisation
    const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    return `${safeName}-${id}`;
}

// recalcule les compteurs affichés dans la fiche du portail
// enregistre le nombre de fichiers et de folders dans la base
async function updatePortalStats(portal_id) {
    try {
        // valeur statistique renvoyée par la requête sql
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
        // données de folders ou de classement renvoyées par la requête sql
        const foldersResult = await pool.query(`
            SELECT COUNT(DISTINCT folder_id) as count
            FROM portal_folders
            WHERE portal_id = $1;
        `, [portal_id]);

        // nombre calculé pour file count
        const file_count = parseInt(countResult.rows[0].count || 0, 10);
        // nombre calculé pour folder count
        const folder_count = parseInt(foldersResult.rows[0].count || 0, 10);
        // libellé lisible du nombre de folders
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

// renvoie la liste plate des folders utilisée pour construire les arbres
app.get('/get_folders', loginRequiredJson, async (req, res) => {
    try {
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query("SELECT id, name, parent_id, creation_date FROM folders ORDER BY folder_order ASC, name ASC;");
        // liste des folders préparée pour cette opération
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

// enregistre le nouvel ordre visuel reçu pour les folders
// regroupe toutes les mises à jour dans une transaction sql
app.post('/update_folder_order', loginRequiredJson, basicAdminRequired, express.json(), async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        const { folder_order } = req.body;
        if (!folder_order || !Array.isArray(folder_order)) {
            return res.status(400).json({ status: "error", message: "Invalid data" });
        }
        // connexion postgresql réservée à la transaction en cours
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

// cache mémoire qui évite de rappeler gemini pour la même recherche
const aiSearchCache = new Map();
// nombre maximal de recherches conservées dans le cache gemini
const AI_CACHE_MAX_SIZE = 200;
// durée de conservation d’une réponse gemini dans le cache
const AI_CACHE_TTL_MS = 1000 * 60 * 60;

// demande à gemini des termes proches pour élargir une recherche
// met le résultat en cache et retourne une liste vide en cas d’erreur
async function expandSearchTermsWithAI(query) {
    // valeur de cache utilisée pour cache key
    const cacheKey = query.toLowerCase().trim();
    // valeur de cache utilisée pour cached
    const cached = aiSearchCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < AI_CACHE_TTL_MS) {
        return cached.terms;
    }

    if (!process.env.GEMINI_API_KEY) {
        console.warn('GEMINI_API_KEY is not defined — AI search disabled.');
        return [];
    }

    try {
        // données reçues pour response
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

        // données reçues pour data
        const data = await response.json();
        // données reçues pour text response
        const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!textResponse) return [];

        // valeur obtenue après la lecture du json
        let parsed;
        try {
            // réponse gemini nettoyée avant la lecture du json
            const cleaned = textResponse.trim().replace(/^```json\s*|```$/g, '');
            parsed = JSON.parse(cleaned);
        } catch (e) {
            console.error('Failed to parse AI search response:', textResponse);
            return [];
        }

        // termes de recherche supplémentaires renvoyés par gemini
        const terms = Array.isArray(parsed.terms) ? parsed.terms.filter(t => typeof t === 'string' && t.trim()) : [];

        if (aiSearchCache.size >= AI_CACHE_MAX_SIZE) {
            // clé la plus ancienne à retirer du cache gemini
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

// renvoie les termes proposés par gemini pour une recherche interne
app.get('/ai_expand_search', loginRequiredJson, async (req, res) => {
    // requête sql construite pour cette opération
    const query = (req.query.q || '').trim();
    if (!query) return res.json({ terms: [] });
    // termes de recherche supplémentaires renvoyés par gemini
    const terms = await expandSearchTermsWithAI(query);
    res.json({ terms });
});

// recherche les fichiers avec le texte, les filtres, le tri et la pagination
// ajoute les termes gemini seulement lorsque le mode ia est demandé
app.get('/search_file', loginRequiredJson, async (req, res) => {
    try {
        // nom utilisé pour retrouver ou enregistrer le fichier
        const filename = req.query.filename;
        // indique si l’élargissement de recherche par gemini est activé
        const aiEnabled = req.query.ai === 'true';
        // liste des tags associés au fichier
        let tags = req.query.tag;
        if (tags && !Array.isArray(tags)) tags = [tags];
        // identifiant du folder actuellement traité
        const folder_id = req.query.folder_id;
        // numéro de la page demandée pour la pagination
        const page = parseInt(req.query.page || 1, 10);
        // nombre maximal de lignes affichées sur une page
        const per_page = parseInt(req.query.per_page || 100, 10);
        // nombre de lignes ignorées avant la page demandée
        const offset = (page - 1) * per_page;
        // tri choisi pour ordonner les résultats
        const sort = req.query.sort || 'name_asc';
        // filtre choisi pour limiter les résultats
        const filter = req.query.filter || 'all';
        // filtre utilisé pour section filter
        const sectionFilter = req.query.section;
        // filtre utilisé pour category filter
        const categoryFilter = req.query.category;

        // termes ajoutés par gemini à la recherche saisie
        let aiTerms = [];
        if (aiEnabled && filename && filename.trim().length > 1) {
            aiTerms = await expandSearchTermsWithAI(filename.trim());
        }

        // extension du fichier actuellement traité
        const ext = {
            images: ["'%.png'", "'%.jpg'", "'%.jpeg'", "'%.jpe'", "'%.gif'", "'%.bmp'", "'%.svg'", "'%.webp'", "'%.tif'", "'%.tiff'", "'%.avif'", "'%.dng'", "'%.cr2'", "'%.nef'", "'%.arw'"],
            videos: ["'%.mp4'", "'%.mov'", "'%.avi'", "'%.wmv'", "'%.flv'", "'%.mkv'", "'%.webm'"],
            audio: ["'%.mp3'", "'%.wav'", "'%.aac'", "'%.flac'", "'%.ogg'", "'%.m4a'"],
            documents: ["'%.pdf'", "'%.doc'", "'%.docx'", "'%.xls'", "'%.xlsx'", "'%.txt'", "'%.rtf'", "'%.odt'"],
            presentations: ["'%.ppt'", "'%.pptx'", "'%.key'", "'%.odp'"]
        };
        // ensemble des extensions reconnues par le serveur
        const allKnownExts = [...ext.images, ...ext.videos, ...ext.audio, ...ext.documents, ...ext.presentations];
        // requête sql construite pour cette opération
        let query = `
            SELECT nom_fichier, lien_telechargement, description, tags, is_exclusive, date_ajout, date_event, folder_id, thumbnail_url,
                   COUNT(*) OVER() as total_count
            FROM documents
            WHERE 1=1
        `;
        // paramètres préparés pour exécuter la requête sans concaténer les valeurs
        const params = [];
        if (filename) {
            // mots extraits du texte recherché
            const searchWords = filename.split(/\s+/).filter(w => w.length > 0);
            // ensemble des mots saisis et des termes ajoutés par gemini
            const allTerms = [...searchWords, ...aiTerms];

            // filtre utilisé pour word conditions
            const wordConditions = [];
            for (const word of allTerms) {
                // mot entouré de jokers pour la recherche sql
                const searchTerm = `%${word}%`;
                params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
                // position du dernier paramètre ajouté à la requête sql
                const pLen = params.length;
                wordConditions.push(`(nom_fichier ILIKE $${pLen - 4} OR description ILIKE $${pLen - 3} OR tags::text ILIKE $${pLen - 2} OR section ILIKE $${pLen - 1} OR category ILIKE $${pLen})`);
            }
            if (aiEnabled && aiTerms.length > 0) {
                query += ` AND (${wordConditions.join(" OR ")})`;
            } else {
                query += wordConditions.map(c => ` AND ${c}`).join('');
            }
        }

        if (tags && tags.length > 0) {
            // filtre utilisé pour tag conditions
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

        if (filter === 'exclusive') {
            query += ` AND is_exclusive = TRUE`;
        } else if (filter === 'favorites') {
            // adresse email utilisée pour user email
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

        // colonne sql utilisée pour trier les résultats
        let orderBy = 'ORDER BY LOWER(nom_fichier) ASC';
        if (sort === 'name_desc') orderBy = 'ORDER BY LOWER(nom_fichier) DESC';
        if (sort === 'date_desc') orderBy = 'ORDER BY date_ajout DESC NULLS LAST';

        query += ` ${orderBy}`;

        params.push(per_page, offset);
        query += ` LIMIT $${params.length - 1} OFFSET $${params.length};`;

        // lignes renvoyées par la requête sql en cours
        const result = await pool.query(query, params);

        // nombre calculé pour total count
        let total_count = 0;
        if (result.rows.length > 0) {
            total_count = parseInt(result.rows[0].total_count, 10);
        }

        // transforme une date en texte simple pour l’affichage
        // retourne une valeur neutre lorsque la date est absente ou invalide
        const formatDate = (dateObj) => {
            if (!dateObj) return null;
            // objet date utilisé pendant le formatage
            const d = new Date(dateObj);
            // jour extrait de la date
            const day = String(d.getDate()).padStart(2, '0');
            // mois extrait de la date
            const month = String(d.getMonth() + 1).padStart(2, '0');
            // année extraite de la date
            const year = d.getFullYear();
            return `${day}-${month}-${year}`;
        };

        // liste des fichiers préparée pour cette opération
        const files = result.rows.map(row => {
            // liste des tags obtenue après la lecture de leur valeur
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

        // folders dont le nom correspond à la recherche
        let matchingFolders = [];
        if (filename && filename.trim().length > 0) {
            // termes utilisés pour rechercher les folders
            const folderTermsSet = aiEnabled ? [filename.trim(), ...aiTerms] : [filename.trim()];
            // paramètres préparés pour exécuter la requête sans concaténer les valeurs
            const folderParams = [];
            // filtre utilisé pour folder conditions
            const folderConditions = folderTermsSet.map(term => {
                folderParams.push(`%${term}%`);
                return `name ILIKE $${folderParams.length}`;
            });
            // requête sql construite pour cette opération
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
            // données de folders ou de classement renvoyées par la requête sql
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

// reconstruit un arbre de folders à partir de la liste plate
// range chaque folder sous son parent avant de retourner les racines
function buildFolderHierarchy(folders) {
    // table de correspondance utilisée pour folder map
    const folderMap = new Map();
    folders.forEach(f => folderMap.set(f.id, { ...f, subfolders: [] }));
    // folders sans parent placés à la racine de l’arbre
    const rootFolders = [];
    // range chaque folder sous son parent pour reconstruire l’arbre
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

// affiche le formulaire de dépôt aux rôles autorisés
app.get('/upload', loginRequiredHtml, uploadAccessRequired, async (req, res) => {
    try {
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query("SELECT id, name, parent_id FROM folders ORDER BY name;");
        // liste des folders préparée pour cette opération
        const folders = buildFolderHierarchy(result.rows);
        // données des portails renvoyées par la requête sql
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

// envoie les fichiers dans azure puis crée leurs lignes dans postgresql
// ajoute aussi l’association portail lorsque le formulaire la demande
app.post('/upload', loginRequiredJson, uploadAccessRequired, (req, res, next) => {
    // intercepte les erreurs d’upload avant de poursuivre la route
    uploadStream.array("files")(req, res, function (err) {
        if (err) {
            if (err.message.startsWith('Extension_Error')) {
                // extension du fichier actuellement traité
                const ext = err.message.split(':')[1];
                return res.status(400).json({ status: "error", message: `Extension '${ext}' not allowed` });
            }
            if (err.message.startsWith('FileExists_Error')) {
                // nom du fichier extrait du message d’erreur
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
// traite les fichiers acceptés puis enregistre leurs métadonnées
}, async (req, res) => {
    try {
        // liste des fichiers préparée pour cette opération
        const files = req.files || [];
        // descriptions reçues pour les fichiers uploadés
        const descriptions = [].concat(req.body.descriptions || []);
        // liste utilisée pour tags list
        const tags_list = [].concat(req.body.tags || []);
        // valeur de date utilisée pour date events
        const date_events = [].concat(req.body.date_events || []);
        // identifiant de folder utilisé pour folder ids
        const folder_ids = [].concat(req.body.folder_ids || []);
        // identifiant de portail utilisé pour portal ids
        const portal_ids = [].concat(req.body.portal_ids || []);
        // sections reçues pour les fichiers uploadés
        const sections = [].concat(req.body.sections || req.body.section || []);
        // catégories reçues pour les fichiers uploadés
        const categories = [].concat(req.body.categories || req.body.category || []);
        // adresse utilisée pour uploaded urls
        const uploaded_urls = [];
        // valeur de date utilisée pour current date
        const currentDate = new Date().toISOString().split('T')[0];
        // statuts exclusifs reçus pour les fichiers uploadés
        const is_exclusives = [].concat(req.body.is_exclusives || []);
        // liste utilisée pour metadata list
        const metadata_list = [].concat(req.body.metadata || []);

        // rôle utilisé pour user role
        const user_role = req.session.user_role;

        for (let i = 0; i < files.length; i++) {
            // élément actuellement traité pour file
            const file = files[i];
            // nom utilisé pour retrouver ou enregistrer le fichier
            const filename = file.filename;
            // adresse utilisée pour blob url
            const blob_url = file.url;
            // taille utilisée pour size bytes
            const size_bytes = file.size;
            // nom original du fichier en cours d’upload
            const originalName = file.originalname;
            // extension du fichier actuellement traité
            const ext = require('path').extname(originalName).toLowerCase();
            // description associée au fichier traité
            const description = descriptions[i] || "";

            // liste des tags associés au fichier
            let tags = [];
            try { tags = JSON.parse(tags_list[i] || "[]"); } catch (e) { }

            // identifiant du folder actuellement traité
            const folder_id = folder_ids[i] || null;
            // identifiant du portail actuellement traité
            const portal_id = (portal_ids[i] && portal_ids[i] !== "none") ? portal_ids[i] : null;
            // section associée au fichier traité
            const section = sections[i] || sections[0] || null;
            // catégorie associée au fichier traité
            const category = categories[i] || categories[0] || null;
            // valeur de date utilisée pour date event
            let date_event = null;

            if (date_events[i]) {
                // parties séparées de la date reçue
                const parts = date_events[i].split('-');
                if (parts.length === 3) date_event = `${parts[2]}-${parts[1]}-${parts[0]}`;
            }

            // indique si le fichier doit être marqué comme exclusif
            const is_exclusive = (is_exclusives[i] === 'true');

            // objet qui regroupe les métadonnées pour metadata
            let metadata = {};
            try {
                if (metadata_list[i]) {
                    metadata = typeof metadata_list[i] === 'string' ? JSON.parse(metadata_list[i]) : metadata_list[i];
                }
            } catch (e) {
                console.error("Error parsing file metadata:", e);
            }

            // indique si la session possède les droits admin
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

            await pool.query(`
                INSERT INTO documents (
                    nom_fichier, lien_telechargement, description, tags,
                    date_ajout, date_event, folder_id, section, category, is_exclusive, metadata
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);
            `, [filename, blob_url, description, JSON.stringify(tags), currentDate, date_event, folder_id, section, category, is_exclusive, JSON.stringify(metadata)]);

            if (portal_id) {
                // catégorie technique enregistrée pour le fichier
                let file_type = "Other";
                if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) file_type = "Image";
                else if (['.mp4', '.mov', '.avi', '.wmv'].includes(ext)) file_type = "Video";
                else if (['.pdf'].includes(ext)) file_type = "PDF";
                else if (['.doc', '.docx'].includes(ext)) file_type = "Document";
                else if (['.xls', '.xlsx'].includes(ext)) file_type = "Spreadsheet";

                // taille lisible affichée à l’utilisateur
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
                        file: filename,
                        user: getAuditUser(req)
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

// renvoie les détails complets d’un fichier pour remplir la modale
// limite une session client aux fichiers visibles dans son propre portail
app.get('/file_details', async (req, res) => {
    try {
        // nom utilisé pour retrouver le fichier
        const filename = req.query.filename;
        if (!filename) {
            return res.status(400).json({ status: "error", error: "Filename required" });
        }

        // session interne ou session client limitée à son portail
        const isInternalUser = !!req.session.user_email;
        const portalAccessId = parseInt(req.session.portal_access, 10);
        const isPortalUser = !!req.session.portal_user_email && Number.isInteger(portalAccessId);
        if (!isInternalUser && !isPortalUser) {
            return res.status(401).json({ status: "error", error: "Unauthorized" });
        }

        if (!isInternalUser) {
            // périmètre réellement affiché par le portail courant
            const visibilityCheck = await pool.query(`
                WITH RECURSIVE allowed_folders AS (
                    SELECT id
                    FROM folders
                    WHERE id = (SELECT root_folder_id FROM portals WHERE id = $1)

                    UNION

                    SELECT folder_id AS id
                    FROM portal_folders
                    WHERE portal_id = $1
                      AND (SELECT root_folder_id FROM portals WHERE id = $1) IS NULL

                    UNION ALL

                    SELECT f.id
                    FROM folders f
                    INNER JOIN allowed_folders af ON f.parent_id = af.id
                )
                SELECT EXISTS (
                    SELECT 1
                    FROM portal_files pf
                    WHERE pf.portal_id = $1 AND pf.filename = $2

                    UNION ALL

                    SELECT 1
                    FROM documents d
                    WHERE d.nom_fichier = $2
                      AND d.folder_id IN (SELECT id FROM allowed_folders)
                ) AS allowed;
            `, [portalAccessId, filename]);

            if (!visibilityCheck.rows[0]?.allowed) {
                return res.status(403).json({ status: "error", error: "File is not available in this portal" });
            }
        }

        // données du document, du folder et de ses métadonnées métier
        const docResult = await pool.query(`
            SELECT d.nom_fichier, d.lien_telechargement, d.description, d.tags,
                   d.date_ajout, d.is_exclusive, d.date_event, d.folder_id,
                   d.section, d.category, d.metadata, f.name AS folder_name
            FROM documents d
            LEFT JOIN folders f ON f.id = d.folder_id
            WHERE d.nom_fichier = $1;
        `, [filename]);

        if (docResult.rows.length === 0) {
            return res.status(404).json({ status: "error", error: "File not found" });
        }

        // portail de la page prioritaire si le fichier est partagé entre plusieurs portails
        const requestedPortalId = parseInt(req.query.portal_id, 10);
        const preferredPortalId = isPortalUser
            ? portalAccessId
            : (Number.isInteger(requestedPortalId) ? requestedPortalId : null);
        const portalResult = await pool.query(`
            SELECT pf.portal_id, p.name AS portal_name
            FROM portal_files pf
            LEFT JOIN portals p ON pf.portal_id = p.id
            WHERE pf.filename = $1
            ORDER BY CASE
                WHEN $2::int IS NOT NULL AND pf.portal_id = $2::int THEN 0
                ELSE 1
            END
            LIMIT 1;
        `, [filename, preferredPortalId]);

        // document actuellement traité
        const doc = docResult.rows[0];
        // identifiant du portail actuellement traité
        const portal_id = portalResult.rows.length > 0 ? portalResult.rows[0].portal_id : preferredPortalId;
        // nom du portail associé au fichier
        const portal_name = portalResult.rows.length > 0 ? portalResult.rows[0].portal_name : null;

        // transforme une date en texte simple pour l’affichage
        const formatDate = (dateObj) => {
            if (!dateObj) return "";
            // objet date utilisé pendant le formatage
            const d = new Date(dateObj);
            // jour extrait de la date
            const day = String(d.getDate()).padStart(2, '0');
            // mois extrait de la date
            const month = String(d.getMonth() + 1).padStart(2, '0');
            // année extraite de la date
            const year = d.getFullYear();
            return `${day}-${month}-${year}`;
        };

        // liste des tags obtenue après la lecture de leur valeur
        let parsedTags = [];
        try {
            if (typeof doc.tags === 'string') parsedTags = JSON.parse(doc.tags);
            else if (Array.isArray(doc.tags)) parsedTags = doc.tags;
        } catch (error) {
            parsedTags = typeof doc.tags === 'string' ? doc.tags.split(',').map(tag => tag.trim()).filter(Boolean) : [];
        }

        // métadonnées existantes converties en objet modifiable
        let parsedMetadata = doc.metadata || {};
        try {
            if (typeof parsedMetadata === 'string') parsedMetadata = JSON.parse(parsedMetadata);
        } catch (error) {
            parsedMetadata = {};
        }
        if (!parsedMetadata || typeof parsedMetadata !== 'object' || Array.isArray(parsedMetadata)) {
            parsedMetadata = {};
        }

        // retourne la première variante renseignée pour les deux champs historiques
        const pickMetadataValue = (...values) => values.find(value =>
            value !== undefined && value !== null && value !== ''
        );
        parsedMetadata.project_name = pickMetadataValue(
            parsedMetadata.project_name,
            parsedMetadata['Project Name'],
            parsedMetadata.projectName
        ) ?? '';
        parsedMetadata.farmer_consent = pickMetadataValue(
            parsedMetadata.farmer_consent,
            parsedMetadata['Farmer Consent'],
            parsedMetadata.farmerConsent
        ) ?? '';

        // catégorie d’aperçu calculée à partir de l’extension
        const extension = require('path').extname(filename).toLowerCase();
        let fileType = "Other";
        if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(extension)) fileType = "Image";
        else if (['.mp4', '.mov', '.avi', '.wmv', '.webm'].includes(extension)) fileType = "Video";
        else if (extension === '.pdf') fileType = "PDF";
        else if (['.doc', '.docx'].includes(extension)) fileType = "Document";
        else if (['.xls', '.xlsx'].includes(extension)) fileType = "Spreadsheet";

        res.json({
            status: "success",
            filename: doc.nom_fichier,
            file_url: doc.lien_telechargement,
            file_type: fileType,
            description: doc.description || "No description",
            tags: parsedTags,
            date_ajout: formatDate(doc.date_ajout),
            is_exclusive: Boolean(doc.is_exclusive),
            date_event: formatDate(doc.date_event),
            folder_id: doc.folder_id,
            folder_name: doc.folder_name || null,
            portal_id,
            portal_name,
            section: doc.section || "",
            category: doc.category || "",
            metadata: parsedMetadata
        });

    } catch (error) {
        console.error("Erreur dans file_details:", error);
        res.status(500).json({ status: "error", error: "Erreur serveur interne" });
    }
});

// crée un folder avec le parent transmis par l’interface
// retourne son identifiant pour l’ajouter immédiatement dans l’arbre
app.post('/create_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        // nom de l’élément actuellement traité
        const name = req.body.name;
        // identifiant du parent choisi pour le nouveau folder
        const parent_id = (req.body.parent_id && req.body.parent_id !== "none") ? req.body.parent_id : null;

        if (!name) {
            return res.status(400).json({ status: "error", message: "Required folder name" });
        }

        // 1. Création du dossier
        const result = await pool.query(
            "INSERT INTO folders (name, parent_id) VALUES ($1, $2) RETURNING id;",
            [name, parent_id]
        );
        const folder_id = result.rows[0].id;

        // 2. Récupération du chemin complet via une requête SQL récursive
        let fullPath = name; // Par défaut, juste le nom (s'il est à la racine)
        
        if (parent_id) {
            const pathResult = await pool.query(`
                WITH RECURSIVE folder_tree AS (
                    -- On part du dossier qu'on vient de créer
                    SELECT id, parent_id, name::text AS path
                    FROM folders
                    WHERE id = $1
                    
                    UNION ALL
                    
                    -- On remonte les parents en boucle et on ajoute leur nom au chemin
                    SELECT p.id, p.parent_id, (p.name || '/' || c.path)
                    FROM folders p
                    INNER JOIN folder_tree c ON c.parent_id = p.id
                )
                -- On récupère la ligne finale (celle qui n'a plus de parent)
                SELECT path FROM folder_tree WHERE parent_id IS NULL;
            `, [folder_id]);
            
            if (pathResult.rows.length > 0) {
                fullPath = pathResult.rows[0].path;
            }
        }

        // 3. Envoi au mouchard (Application Insights)
        if (typeof insightsClient !== 'undefined' && insightsClient) {
            insightsClient.trackEvent({
                name: "folder_created",
                properties: {
                    folder_name: name,
                    full_path: fullPath, // EX: "Rapports/Finance/2026"
                    user: typeof getAuditUser === 'function' ? getAuditUser(req) : "Unknown"
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

// supprime un folder après la confirmation de l’utilisateur
// la base applique ensuite les contraintes prévues sur ses relations
app.post('/delete_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        // identifiant du folder actuellement traité
        const folder_id = req.body.folder_id;

        if (!folder_id) {
            return res.status(400).json({ status: "error", message: "ID du dossier requis" });
        }

        // ligne supprimée et renvoyée par postgresql
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
        // nom du folder actuellement traité
        const folderName = delRes.rows.length > 0 ? delRes.rows[0].name : "Dossier Inconnu";
        insightsClient.trackEvent({
            name: "folder_deleted",
            properties: {
                folder_name: folderName,
                user: getAuditUser(req)
            }
        });
        res.json({ status: "success" });
    } catch (error) {
        console.error("Erreur delete_folder:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// modifie le nom d’un folder sans changer son parent ni son identifiant
app.post('/rename_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        const { folder_id, new_name } = req.body;
        if (!folder_id || !new_name || new_name.trim() === "") {
            return res.status(400).json({ status: "error", message: "Valid ID and new name required" });
        }
        // nouveau nom nettoyé avant son enregistrement
        const cleanName = new_name.trim();
        // résultat renvoyé par la requête sql
        const selectRes = await pool.query("SELECT name FROM folders WHERE id = $1;", [folder_id]);
        if (selectRes.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "folder not found" });
        }
        // nom du folder avant sa modification
        const ancienNom = selectRes.rows[0].name;
        await pool.query("UPDATE folders SET name = $1 WHERE id = $2;", [cleanName, folder_id]);
        if (typeof insightsClient !== 'undefined' && insightsClient) {
            insightsClient.trackEvent({
                name: "folder_renamed",
                properties: {
                    ancien_nom: ancienNom,
                    nouveau_nom: cleanName,
                    dossier_id: folder_id,
                    admin: getAuditUser(req)
                }
            });
        }
        res.json({ status: "success", new_name: cleanName });
    } catch (error) {
        console.error("Erreur rename_folder:", error);
        res.status(500).json({ status: "error", message: "Error renaming in the database" });
    }
});

// place un fichier dans le folder demandé par la modale
// recrée sa ligne document si elle existe seulement dans un portail
app.post('/update_file_folder', loginRequiredJson, basicAdminRequired, async (req, res) => {
    try {
        // nom utilisé pour retrouver ou enregistrer le fichier
        const filename = req.body?.filename || req.query?.filename;
        // identifiant du folder actuellement traité
        const folder_id = req.body?.folder_id || req.query?.folder_id;
        // portail transmis par la page portail pour limiter les folders proposés
        const portal_id = req.body?.portal_id || req.query?.portal_id;
        if (!filename || !folder_id) {
            return res.status(400).json({ status: 'error', message: 'Parameters missing' });
        }
        // identifiant numérique du folder vérifié avant toute requête sql
        const targetFolderId = Number(folder_id);
        if (!Number.isInteger(targetFolderId) || targetFolderId <= 0) {
            return res.status(400).json({ status: 'error', message: 'Invalid folder' });
        }
        if (portal_id) {
            // identifiant numérique du portail utilisé pour contrôler le périmètre
            const targetPortalId = Number(portal_id);
            if (!Number.isInteger(targetPortalId) || targetPortalId <= 0) {
                return res.status(400).json({ status: 'error', message: 'Invalid portal' });
            }
            // vérifie que le folder appartient bien au périmètre configuré du portail
            const linkedFolder = await pool.query(`
                SELECT 1 FROM portal_folders
                WHERE portal_id = $1 AND folder_id = $2
                LIMIT 1;
            `, [targetPortalId, targetFolderId]);
            if (linkedFolder.rows.length === 0) {
                return res.status(400).json({ status: 'error', message: 'The selected folder is not linked to this portal' });
            }
        }
        // données de fichiers renvoyées par la requête sql
        const docCheck = await pool.query("SELECT * FROM documents WHERE nom_fichier = $1", [filename]);
        if (docCheck.rows.length > 0) {
            await pool.query("UPDATE documents SET folder_id = $1 WHERE nom_fichier = $2", [targetFolderId, filename]);
        }
        else {
            // données des portails renvoyées par la requête sql
            const portalFileCheck = await pool.query("SELECT * FROM portal_files WHERE filename = $1", [filename]);

            if (portalFileCheck.rows.length > 0) {
                // données du fichier récupérées depuis le portail
                const fileData = portalFileCheck.rows[0];
                await pool.query(`
                    INSERT INTO documents (nom_fichier, lien_telechargement, description, type_doc, folder_id, date_ajout)
                    VALUES ($1, $2, $3, $4, $5, NOW())
                `, [fileData.filename, fileData.file_url, fileData.description, fileData.file_type, targetFolderId]);

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


// retire le folder d’un fichier en mettant son folder_id à null
app.post('/r_file_folder', loginRequiredJson, basicAdminRequired, async (req, res) => {
    try {
        // nom utilisé pour retrouver ou enregistrer le fichier
        const filename = req.body?.filename || req.query?.filename;
        // identifiant du portail actuellement traité
        const portal_id = req.body?.portal_id || req.query?.portal_id || req.session?.portal_access;
        if (!filename) return res.status(400).json({ status: 'error', message: 'Nom de fichier manquant' });
        // données de fichiers renvoyées par la requête sql
        const docCheck = await pool.query("SELECT * FROM documents WHERE nom_fichier = $1", [filename]);
        if (docCheck.rows.length > 0) {
            // données du document récupérées depuis la base
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

// déplace tous les fichiers sélectionnés vers le même folder
app.post('/bulk_update_file_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        const { folder_id, filenames } = req.body;
        // liste utilisée pour files array
        const filesArray = JSON.parse(filenames || "[]");
        // folder choisi comme destination de l’opération
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

// affecte plusieurs fichiers à un portail et à un folder autorisé
// vérifie le root folder puis applique les changements dans une transaction
app.post('/bulk_update_file_portal', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        const { portal_id, folder_id, filenames } = req.body;

        // liste des fichiers obtenue après la lecture du json
        let parsedFiles;
        try {
            parsedFiles = JSON.parse(filenames || "[]");
        } catch (parseError) {
            return res.status(400).json({ status: "error", message: "Invalid file selection" });
        }

        // liste utilisée pour files array
        const filesArray = Array.isArray(parsedFiles)
            ? [...new Set(parsedFiles.filter(filename => typeof filename === 'string' && filename.trim() !== ''))]
            : [];

        if (filesArray.length === 0) {
            return res.status(400).json({ status: "error", message: "No files selected" });
        }
        // identifiant de portail utilisé pour target portal id
        const targetPortalId = parseInt(portal_id, 10);
        if (!portal_id || portal_id === "none" || !Number.isInteger(targetPortalId)) {
            return res.status(400).json({ status: "error", message: "No portal selected" });
        }

        // identifiant du folder choisi comme destination
        const targetFolderId = parseInt(folder_id, 10);
        if (!folder_id || folder_id === "none" || !Number.isInteger(targetFolderId)) {
            return res.status(400).json({ status: "error", message: "No destination folder selected" });
        }

        // résultat renvoyé par la requête sql
        const destinationRes = await pool.query(`
            SELECT p.id AS portal_id, p.name AS portal_name, p.root_folder_id,
                   f.id AS folder_id, f.name AS folder_name
            FROM portals p
            JOIN portal_folders pf ON pf.portal_id = p.id
            JOIN folders f ON f.id = pf.folder_id
            WHERE p.id = $1 AND f.id = $2
            LIMIT 1;
        `, [targetPortalId, targetFolderId]);

        if (destinationRes.rows.length === 0) {
            return res.status(400).json({
                status: "error",
                message: "The selected folder is not linked to this portal"
            });
        }

        // folder de destination contrôlé avant le déplacement
        const destination = destinationRes.rows[0];

        if (destination.root_folder_id) {
            // résultat utilisé pour vérifier les données dans postgresql
            const scopeCheck = await pool.query(`
                WITH RECURSIVE folder_tree AS (
                    SELECT id FROM folders WHERE id = $1
                    UNION
                    SELECT f.id
                    FROM folders f
                    INNER JOIN folder_tree ft ON f.parent_id = ft.id
                )
                SELECT 1 FROM folder_tree WHERE id = $2 LIMIT 1;
            `, [destination.root_folder_id, targetFolderId]);

            if (scopeCheck.rows.length === 0) {
                return res.status(400).json({
                    status: "error",
                    message: `The selected folder is outside of the Root Folder hierarchy for '${destination.portal_name}'`
                });
            }
        }

        // données de fichiers renvoyées par la requête sql
        const documentsRes = await pool.query(`
            SELECT nom_fichier, lien_telechargement, description, tags, date_ajout
            FROM documents
            WHERE nom_fichier = ANY($1::text[]);
        `, [filesArray]);

        // noms des documents retrouvés dans la base
        const foundFiles = new Set(documentsRes.rows.map(document => document.nom_fichier));
        // noms demandés qui ne correspondent à aucun document
        const missingFiles = filesArray.filter(filename => !foundFiles.has(filename));
        if (missingFiles.length > 0) {
            return res.status(404).json({
                status: "error",
                message: `${missingFiles.length} selected file(s) could not be found`
            });
        }

        // résultat utilisé pour vérifier les données dans postgresql
        const existingRes = await pool.query(`
            SELECT filename
            FROM portal_files
            WHERE portal_id = $1 AND filename = ANY($2::text[]);
        `, [targetPortalId, filesArray]);
        // noms déjà associés au portail
        const existingFiles = new Set(existingRes.rows.map(row => row.filename));

        // fichiers restant à associer au portail
        const portalFilesToInsert = [];
        for (const document of documentsRes.rows) {
            if (existingFiles.has(document.nom_fichier)) continue;

            // extension du fichier actuellement traité
            const ext = require('path').extname(document.nom_fichier).toLowerCase();
            // catégorie technique enregistrée pour le fichier
            let fileType = "Other";
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) fileType = "Image";
            else if (['.mp4', '.mov', '.avi', '.wmv'].includes(ext)) fileType = "Video";
            else if (ext === '.pdf') fileType = "PDF";
            else if (['.doc', '.docx'].includes(ext)) fileType = "Document";
            else if (['.xls', '.xlsx'].includes(ext)) fileType = "Spreadsheet";

            // client azure qui agit sur le blob du fichier courant
            const blockBlobClient = containerClient.getBlockBlobClient(document.nom_fichier);
            // propriétés du blob récupérées depuis azure
            const props = await blockBlobClient.getProperties();
            // taille du fichier exprimée en octets
            const sizeBytes = props.contentLength || 0;

            portalFilesToInsert.push({
                filename: document.nom_fichier,
                description: document.description || "No description",
                fileUrl: document.lien_telechargement,
                fileType,
                uploadDate: document.date_ajout,
                sizeBytes,
                size: formatBytes(sizeBytes)
            });
        }

        // connexion postgresql réservée à la transaction en cours
        const client = await pool.connect();
        // nombre calculé pour assigned count
        let assignedCount = 0;
        try {
            await client.query('BEGIN');

            await client.query(`
                UPDATE documents
                SET folder_id = $1
                WHERE nom_fichier = ANY($2::text[]);
            `, [targetFolderId, filesArray]);

            for (const portalFile of portalFilesToInsert) {
                await client.query(`
                    INSERT INTO portal_files
                        (portal_id, filename, description, file_url, file_type, upload_date, size_bytes, size)
                    VALUES
                        ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7, $8);
                `, [
                    targetPortalId,
                    portalFile.filename,
                    portalFile.description,
                    portalFile.fileUrl,
                    portalFile.fileType,
                    portalFile.uploadDate,
                    portalFile.sizeBytes,
                    portalFile.size
                ]);
                assignedCount++;
            }

            await client.query('COMMIT');
        } catch (transactionError) {
            await client.query('ROLLBACK');
            throw transactionError;
        } finally {
            client.release();
        }

        await updatePortalStats(targetPortalId);
        res.json({
            status: "success",
            assigned_count: assignedCount,
            moved_count: filesArray.length,
            folder_id: targetFolderId,
            message: `${filesArray.length} files have been assigned to '${destination.folder_name}' in the '${destination.portal_name}' portal.`
        });
    } catch (error) {
        console.error("Erreur bulk_update_file_portal:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// retire un fichier de tous ses portails sélectionnés
// retire aussi son emplacement dans l’arborescence principale
app.post('/remove_file_portal', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        const { filename, portal_id } = req.body;

        if (!filename || !portal_id) {
            return res.status(400).json({ status: "error", message: "Filename and portal ID are required" });
        }

        await pool.query(
            "DELETE FROM portal_files WHERE filename = $1 AND portal_id = $2;",
            [filename, portal_id]
        );

        await pool.query(
            "UPDATE documents SET folder_id = NULL WHERE nom_fichier = $1;",
            [filename]
        );

        // valeur statistique renvoyée par la requête sql
        const countRes = await pool.query("SELECT COUNT(*) FROM portal_files WHERE portal_id = $1;", [portal_id]);
        // nombre de fichiers encore liés au portail
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
                file: filename,
                user: getAuditUser(req)
            }
        });
        insightsClient.trackEvent({
            name: "remove_file_portal",
            properties: {
                file: filename,
                user: getAuditUser(req)
            }
        });
        res.json({ status: "success" });
    } catch (error) {
        console.error("Erreur remove_file_from_portal:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// complète les tailles manquantes des fichiers de portail depuis azure
app.get('/update_portal_files_sizes', loginRequiredJson, async (req, res) => {
    try {
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query("SELECT id, filename FROM portal_files;");
        // liste des fichiers préparée pour cette opération
        const files = result.rows;
        // nombre calculé pour updated count
        let updatedCount = 0;

        for (let file of files) {
            // client azure qui agit sur le blob du fichier courant
            const blockBlobClient = containerClient.getBlockBlobClient(file.filename);
            // taille du fichier exprimée en octets
            let sizeBytes = 0;

            try {
                // propriétés du blob récupérées depuis azure
                const props = await blockBlobClient.getProperties();
                sizeBytes = props.contentLength;
            } catch (azureErr) {
                console.error(`Impossible de lire la taille pour ${file.filename}`);
            }

            // taille utilisée pour size display
            const sizeDisplay = formatBytes(sizeBytes);

            await pool.query(
                "UPDATE portal_files SET size_bytes = $1, size = $2 WHERE id = $3;",
                [sizeBytes, sizeDisplay, file.id]
            );
            updatedCount++;
        }
        // données des portails renvoyées par la requête sql
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

// retire un fichier de son folder sans supprimer le fichier
app.post('/remove_file_from_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        // nom utilisé pour retrouver ou enregistrer le fichier
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
                file: filename,
                user: getAuditUser(req)
            }
        });
        res.json({ status: "success" });
    } catch (error) {
        console.error("Erreur remove_file_from_folder:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});



// renvoie le folder actuellement enregistré pour un fichier
app.post('/sync_file_folder', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        // nom utilisé pour retrouver ou enregistrer le fichier
        const filename = req.body.filename;

        if (!filename) {
            return res.status(400).json({ status: "error", message: "Required file name" });
        }
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query(
            "SELECT folder_id FROM documents WHERE nom_fichier = $1;",
            [filename]
        );
        // identifiant de folder utilisé pour current folder id
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

// met le folder_id du fichier à null pour le sortir de l’arbre
app.post('/remove_file_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    // nom utilisé pour retrouver ou enregistrer le fichier
    const filename = req.body.filename;
    if (!filename) {
        return res.status(400).json({
            status: "error",
            message: "Le nom du fichier (filename) est manquant dans la requête."
        });
    }
    try {
        // requête sql construite pour cette opération
        const query = "UPDATE documents SET folder_id = NULL WHERE nom_fichier = $1";
        // lignes renvoyées par la requête sql en cours
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

// réaffecte un fichier existant au folder demandé
app.post('/assign_file_folder', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    // valeurs récupérées dans le corps de la requête
    const { filename, folder_id } = req.body;
    if (!filename || !folder_id) {
        return res.status(400).json({
            status: "error",
            message: "Nom du fichier ou ID du dossier manquant."
        });
    }

    try {
        // requête sql construite pour cette opération
        const query = "UPDATE documents SET folder_id = $1 WHERE nom_fichier = $2";
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query(query, [folder_id, filename]);

        if (result.rowCount > 0) {
            insightsClient.trackEvent({
            name: "fichier_reassigner_avec_succes",
            properties: {
                file: filename,
                user: getAuditUser(req)
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

// supprime définitivement un fichier dans azure et dans la base
// nettoie aussi ses associations portail et ses favoris
app.post('/delete', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        // nom utilisé pour retrouver ou enregistrer le fichier
        const filename = req.body.filename;
        // indique si la suppression a été confirmée
        const confirmation = req.body.confirmation === "on";
        if (!confirmation) {
            return res.status(400).json({ status: "error", message: "Confirmation required" });
        }
        if (!filename) {
            return res.status(400).json({ status: "error", message: "Required file name" });
        }
        // client azure qui agit sur le blob du fichier courant
        const blockBlobClient = containerClient.getBlockBlobClient(filename);
        try {
            await blockBlobClient.deleteIfExists();
        } catch (azureError) {
            console.error("Erreur Azure:", azureError);
            return res.status(500).json({ status: "error", message: `Azure error: ${azureError.message}` });
        }

        // données des portails renvoyées par la requête sql
        const portalsResult = await pool.query("SELECT portal_id FROM portal_files WHERE filename = $1;", [filename]);
        // identifiants des portails touchés par la modification
        const affectedPortals = portalsResult.rows.map(row => row.portal_id);

        if (affectedPortals.length > 0) {
            await pool.query("DELETE FROM portal_files WHERE filename = $1;", [filename]);
        }

        await pool.query("DELETE FROM documents WHERE nom_fichier = $1;", [filename]);
        await pool.query("DELETE FROM user_favorites WHERE filename = $1;", [filename]);
        for (let portal_id of affectedPortals) {
            await updatePortalStats(portal_id);
        }
        insightsClient.trackEvent({
            name: "Fichier_Supprime",
            properties: {
                file: filename,
                user: getAuditUser(req)
            }
        });
        res.json({ status: "success", message: `File ${filename} successfully deleted` });

    } catch (error) {
        console.error("Erreur delete_files:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// supprime chaque fichier sélectionné dans azure et dans postgresql
// continue le lot et garde la liste des erreurs rencontrées
app.post('/bulk_delete', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        // liste des noms de fichiers à traiter
        const filenames = JSON.parse(req.body.filenames || '[]');
        if (!Array.isArray(filenames) || filenames.length === 0) {
            return res.status(400).json({ status: 'error', message: 'No files specified' });
        }

        // erreurs gardées pendant le traitement du lot
        const errors = [];
        for (const filename of filenames) {
            try {
                // client azure qui agit sur le blob du fichier courant
                const blockBlobClient = containerClient.getBlockBlobClient(filename);
                await blockBlobClient.deleteIfExists();

                // données des portails renvoyées par la requête sql
                const portalsResult = await pool.query("SELECT portal_id FROM portal_files WHERE filename = $1;", [filename]);
                // identifiants des portails touchés par la modification
                const affectedPortals = portalsResult.rows.map(r => r.portal_id);
                if (affectedPortals.length > 0) {
                    await pool.query("DELETE FROM portal_files WHERE filename = $1;", [filename]);
                }

                await pool.query("DELETE FROM documents WHERE nom_fichier = $1;", [filename]);
                await pool.query("DELETE FROM user_favorites WHERE filename = $1;", [filename]);

                for (const portal_id of affectedPortals) {
                    await updatePortalStats(portal_id);
                }

                insightsClient.trackEvent({
                    name: 'file_deleted',
                    properties: {
                        file: filename,
                        user: getAuditUser(req)
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
// modifie le statut exclusif d’un fichier pour les rôles autorisés
app.post('/update_exclusive', loginRequiredJson, uploaderOrAdminRequired, upload.none(), async (req, res) => {
    // rôle attribué à l’utilisateur connecté
    const role = req.session.user_role;
    if (role !== 'admin' && role != 'basic_admin' && role !== 'uploader') {
        return res.status(403).json({ status: "error", message: "Access denied. Reserved for administrators and uploaders." });
    }
    try {
        // nom utilisé pour retrouver ou enregistrer le fichier
        const filename = req.body.filename;
        // indique si le fichier doit être marqué comme exclusif
        const is_exclusive = req.body.is_exclusive === 'true';

        if (!filename) {
            return res.status(400).json({ status: "error", message: "Required file name" });
        }
        // lignes renvoyées par la requête sql en cours
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

// affiche la page interne qui liste et administre les portails
app.get('/portals', loginRequiredHtml, async (req, res) => {
    try {
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query("SELECT id, name, url, access, creation_date, last_sync FROM portals ORDER BY name;");
        // liste utilisée pour portals list
        const portals_list = [];
        for (let row of result.rows) {
            // valeur statistique renvoyée par la requête sql
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

            // données de folders ou de classement renvoyées par la requête sql
            const foldersResult = await pool.query(`
                SELECT COUNT(DISTINCT folder_id) as count
                FROM portal_folders
                WHERE portal_id = $1;
            `, [row.id]);

            // nombre calculé pour file count
            const file_count = parseInt(countResult.rows[0].count || 0, 10);
            // nombre calculé pour folder count
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

        res.render('portals.html', {
            portals: portals_list,
            is_admin: req.session.is_admin,
            user_role: req.session.user_role,
            user_email: req.session.user_email,
            username: req.session.username
        });
    } catch (error) {
        console.error("Erreur /portals:", error);
        res.status(500).send("Erreur serveur");
    }
});

// renvoie les portails complets utilisés par les modales internes
app.get('/get_all_portals', loginRequiredJson, async (req, res) => {
    try {
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query("SELECT id, name FROM portals ORDER BY name ASC;");
        // portails préparés pour la réponse ou le template
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

// recherche un portail avec son identifiant ou son slug
// retourne la première ligne trouvée dans la base
async function getPortalInfo(identifier) {
    // lignes renvoyées par la requête sql en cours
    const res = await pool.query("SELECT id, name, slug FROM portals WHERE id::text = $1 OR slug = $1 LIMIT 1;", [identifier]);
    return res.rows.length > 0 ? res.rows[0] : null;
}

// affiche la vitrine du portail demandé après contrôle de la session
// prépare les cartes, les couvertures, les compteurs et les fichiers libres
app.get('/portal/:portal_id', async (req, res) => {
    // identifiant ou slug utilisé pour retrouver le portail
    const identifier = req.params.portal_id;
    try {
        // données des portails renvoyées par la requête sql
        const portalRes = await pool.query("SELECT * FROM portals WHERE id::text = $1 OR slug = $1;", [identifier]);
        if (portalRes.rows.length === 0) return res.redirect('/portals');

        // ligne de base contenant le portail demandé
        const portalRow = portalRes.rows[0];
        // identifiant réel du portail après la recherche par slug
        const real_portal_id = portalRow.id;
        // texte court utilisé dans l’url du portail
        const slug = portalRow.slug || real_portal_id;

        if (identifier == real_portal_id.toString() && portalRow.slug) {
            return res.redirect(`/portal/${portalRow.slug}`);
        }

        // indique si la session possède les droits admin
        const isAdmin = req.session.is_admin === true;
        // indique si une session interne est connectée
        const isGlobalAuth = !!req.session.user_email;
        // indique si la session interne peut gérer les fichiers du portail
        const canManageFiles = isGlobalAuth && (isAdmin || req.session.user_role === 'admin' || req.session.user_role === 'basic_admin');
        // indique si la session client ouvre le bon portail
        const isAuthorizedPortalUser = !!req.session.portal_user_email && (req.session.portal_access == real_portal_id);
        if (!isGlobalAuth && !isAuthorizedPortalUser) return res.redirect(`/portal/${slug}/login`);
        // données de folders ou de classement renvoyées par la requête sql
        const linkedFoldersRes = await pool.query(`
            SELECT f.id, f.name, f.creation_date, pf.col_span, pf.row_span, pf.position, pf.custom_title, pf.custom_title_color
            FROM folders f
            JOIN portal_folders pf ON f.id = pf.folder_id
            WHERE pf.portal_id = $1
            ORDER BY pf.position ASC NULLS LAST, f.name ASC;
        `, [real_portal_id]);

        // liste utilisée pour project cards
        const projectCards = [];
        for (let folder of linkedFoldersRes.rows) {
            // résultat renvoyé par la requête sql
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

        // adresse utilisée pour hero url
        const heroUrl = coverRes.rows.length > 0 ? coverRes.rows[0].lien_telechargement : null;
        // indique si la couverture du portail est un pdf
        const isPdfCover = heroUrl ? heroUrl.toLowerCase().includes('.pdf') : false;
        // année extraite de la date
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

        // transforme une date en texte simple pour l’affichage
        // retourne une valeur neutre lorsque la date est absente ou invalide
        const formatDate = (dateString) => {
            if (!dateString) return 'N/A';
            // objet date utilisé pendant le formatage
            const d = new Date(dateString);
            if (isNaN(d.getTime())) return 'N/A';
            return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth()+1).padStart(2, '0')}-${d.getFullYear()}`;        };

        portalRow.display_creation_date = formatDate(portalRow.creation_date);
        portalRow.display_last_sync = formatDate(portalRow.last_sync);
        portalRow.display_size = portalRow.size || '0 B';
        // données de fichiers renvoyées par la requête sql
        const looseFilesRes = await pool.query(`
            WITH RECURSIVE portal_allowed_folders AS (
                SELECT id FROM folders WHERE id = (SELECT root_folder_id FROM portals WHERE id = $1)

                UNION

                SELECT folder_id as id FROM portal_folders WHERE portal_id = $1 AND (SELECT root_folder_id FROM portals WHERE id = $1) IS NULL

                UNION ALL

                SELECT f.id FROM folders f
                INNER JOIN portal_allowed_folders paf ON f.parent_id = paf.id
            )
            SELECT pf.*, d.folder_id, f.name AS folder_name,
                   d.description AS document_description,
                   d.tags AS document_tags,
                   d.date_ajout AS document_date_added,
                   d.date_event AS document_event_date,
                   d.section AS document_section,
                   d.category AS document_category,
                   d.metadata AS document_metadata
            FROM portal_files pf
            LEFT JOIN documents d ON d.nom_fichier = pf.filename
            LEFT JOIN folders f ON f.id = d.folder_id
            WHERE pf.portal_id = $1
              AND (d.folder_id IS NULL OR d.folder_id NOT IN (SELECT id FROM portal_allowed_folders))
            ORDER BY pf.upload_date DESC NULLS LAST;
        `, [real_portal_id]);

        // nombre calculé pour total files count
        let total_files_count = 0;
        // nombre calculé pour total folders count
        let total_folders_count = 0;

        if (portalRow.root_folder_id) {
            // valeur statistique renvoyée par la requête sql
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

            // valeur statistique renvoyée par la requête sql
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
            // valeur statistique renvoyée par la requête sql
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

            // valeur statistique renvoyée par la requête sql
            const totalFoldersRes = await pool.query(`
                SELECT COUNT(DISTINCT folder_id) as count
                FROM portal_folders
                WHERE portal_id = $1;
            `, [real_portal_id]);
            total_folders_count = parseInt(totalFoldersRes.rows[0].count || 0, 10);
        }

        // fichiers du portail qui ne sont affichés dans aucune carte
        const looseFiles = looseFilesRes.rows.map(row => {
            // tags normalisés pour l’attribut de carte utilisé avant la réponse api
            let tags = row.document_tags || row.tags || [];
            if (typeof tags === 'string') {
                try {
                    const parsedTags = JSON.parse(tags);
                    tags = Array.isArray(parsedTags) ? parsedTags : tags.split(',');
                } catch (error) {
                    tags = tags.split(',');
                }
            }
            if (!Array.isArray(tags)) tags = [];
            tags = tags.map(tag => String(tag).trim()).filter(Boolean);

            return {
                filename: row.filename,
                file_url: row.file_url,
                description: row.document_description || row.description || "No description",
                file_type: row.file_type || (row.filename && row.filename.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? 'Image' : 'File'),
                size: row.size || '0 B',
                size_bytes: Number(row.size_bytes) || 0,
                upload_date: formatDate(row.document_date_added || row.upload_date || row.created_at),
                date_event: formatDate(row.document_event_date),
                section: row.document_section || "Not specified",
                category: row.document_category || "Not specified",
                tags,
                metadata: row.document_metadata || {},
                folder_name: row.folder_name || null
            };
        });

        const allPortalFilesRes = await pool.query(`
            WITH RECURSIVE portal_allowed_folders AS (
                SELECT id FROM folders WHERE id = (SELECT root_folder_id FROM portals WHERE id = $1)
                
                UNION
                
                SELECT folder_id as id FROM portal_folders WHERE portal_id = $1 AND (SELECT root_folder_id FROM portals WHERE id = $1) IS NULL
                
                UNION ALL
                
                SELECT f.id FROM folders f
                INNER JOIN portal_allowed_folders paf ON f.parent_id = paf.id
            )
            SELECT d.nom_fichier as filename, d.lien_telechargement as file_url, 
                   d.description, d.date_ajout, d.date_event, d.tags, d.is_exclusive, f.name as folder_name, d.folder_id,
                   d.section, d.category, d.metadata
            FROM documents d
            LEFT JOIN folders f ON f.id = d.folder_id
            WHERE d.folder_id IN (SELECT id FROM portal_allowed_folders) 
               OR d.nom_fichier IN (SELECT filename FROM portal_files WHERE portal_id = $1);
        `, [real_portal_id]);

        const allPortalFiles = allPortalFilesRes.rows.map(row => {
            let tags = row.tags || [];
            if (typeof tags === 'string') {
                try {
                    const parsedTags = JSON.parse(tags);
                    tags = Array.isArray(parsedTags) ? parsedTags : tags.split(',');
                } catch (error) {
                    tags = tags.split(',');
                }
            }
            if (!Array.isArray(tags)) tags = [];
            tags = tags.map(tag => String(tag).trim()).filter(Boolean);

            return {
                filename: row.filename,
                file_url: row.file_url,
                description: row.description || "No description",
                file_type: row.filename && row.filename.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? 'Image' : (row.filename && row.filename.match(/\.pdf$/i) ? 'PDF' : 'File'),
                upload_date: formatDate(row.date_ajout),
                date_event: formatDate(row.date_event),
                section: row.section || "Not specified",
                category: row.category || "Not specified",
                tags,
                metadata: row.metadata || {},
                folder_name: row.folder_name || null
            };
        });

        res.render('portal_page.html', {
            portal: portalRow,
            projectCards: projectCards,
            looseFiles: looseFiles,
            all_portal_files_json: JSON.stringify(allPortalFiles),
            is_admin: isAdmin,
            is_global_auth: isGlobalAuth,
            can_manage_files: canManageFiles,
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

// enregistre l’ordre, la taille et le titre des cartes du portail
// réserve cette personnalisation au rôle admin
app.post('/portal/:portal_id/layout', adminRequired, upload.none(), async (req, res) => {
    try {
        // lignes renvoyées par la requête sql en cours
        const p = await pool.query("SELECT id FROM portals WHERE id::text = $1 OR slug = $1;", [req.params.portal_id]);
        if (p.rows.length === 0) return res.status(404).json({ status: "error", message: "Portal not found" });
        // identifiant de portail utilisé pour portal id
        const portalId = p.rows[0].id;
        // éléments de mise en page reçus depuis le formulaire
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

// ouvre la sandbox du portail dans le folder demandé
// construit un arbre limité au périmètre calculé pour ce client
app.get('/portal/:portal_id/folder/:folder_id', loginRequiredHtml, async (req, res) => {
    // identifiant ou slug utilisé pour retrouver le portail
    const identifier = req.params.portal_id;
    // identifiant du folder choisi comme destination
    const targetFolderId = parseInt(req.params.folder_id, 10);

    try {
        // données des portails renvoyées par la requête sql
        const portalRes = await pool.query("SELECT * FROM portals WHERE id::text = $1 OR slug = $1;", [identifier]);
        if (portalRes.rows.length === 0) return res.redirect('/portals');
        // ligne de base contenant le portail demandé
        const portalRow = portalRes.rows[0];
        // identifiant réel du portail après la recherche par slug
        const real_portal_id = portalRow.id;
        // texte court utilisé dans l’url du portail
        const slug = portalRow.slug || real_portal_id;
        // indique si la session possède les droits admin
        const isAdmin = req.session.is_admin === true;
        // indique si une session interne est connectée
        const isGlobalAuth = !!req.session.user_email;
        // indique si la session client ouvre le bon portail
        const isAuthorizedPortalUser = !!req.session.portal_user_email && (req.session.portal_access == real_portal_id);

        if (!isGlobalAuth && !isAuthorizedPortalUser) return res.redirect(`/portal/${slug}/login`);

        // résultat utilisé pour vérifier les données dans postgresql
        const rootCheck = await pool.query("SELECT folder_id FROM portal_folders WHERE portal_id = $1;", [real_portal_id]);
        // racines autorisées pour la sandbox du portail
        let allowedRoots = rootCheck.rows.map(r => r.folder_id);
        if (portalRow.root_folder_id && !allowedRoots.includes(portalRow.root_folder_id)) {
            allowedRoots.push(portalRow.root_folder_id);
        }
        // données de folders ou de classement renvoyées par la requête sql
        const allFoldersRes = await pool.query("SELECT id, name, parent_id, creation_date FROM folders ORDER BY name;");
        // folders utilisés pour reconstruire le périmètre du portail
        const allFolders = allFoldersRes.rows;
        // racine autorisée trouvée pour le folder ouvert
        let currentRoot = null;
        // identifiant remonté de parent en parent dans l’arbre
        let tempId = targetFolderId;
        while(tempId) {
            if (allowedRoots.includes(tempId)) {
                currentRoot = tempId;
            }
            // folder parent trouvé pendant le parcours de l’arbre
            const parent = allFolders.find(f => f.id === tempId);
            tempId = parent ? parent.parent_id : null;
        }
        if (!currentRoot && !isAdmin) {
            return res.status(403).send("Access denied: This folder does not belong to your account.");
        }
        if (!currentRoot && isAdmin) currentRoot = targetFolderId;
        // identifiants autorisés sous la racine du portail
        let allowedDescendants = new Set([currentRoot]);
        // indique si le dernier passage a ajouté un descendant
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

        // identifiant de folder utilisé pour project folders ids
        let projectFoldersIds = new Set([...allowedDescendants]);
        // identifiant du portail ou du parent en cours de traitement
        let pId = allFolders.find(f => f.id === currentRoot)?.parent_id;
        while(pId) {
            projectFoldersIds.add(pId);
            pId = allFolders.find(f => f.id === pId)?.parent_id;
        }

        // folders du projet à afficher dans la sandbox
        const projectFolders = allFolders.filter(f => projectFoldersIds.has(f.id));
        // données de fichiers renvoyées par la requête sql
        const filesRes = await pool.query(`
            SELECT d.id as doc_id, d.nom_fichier as filename, d.lien_telechargement as file_url,
                   d.description, d.date_ajout, d.date_event, d.tags, d.is_exclusive, f.name as folder_name, d.folder_id,
                   d.section, d.category
            FROM documents d
            LEFT JOIN folders f ON d.folder_id = f.id
            WHERE d.folder_id = ANY($1::int[])
            ORDER BY d.date_ajout DESC NULLS LAST;
        `, [Array.from(projectFoldersIds)]);

        // transforme une date en texte simple pour l’affichage
        // retourne une valeur neutre lorsque la date est absente ou invalide
        const formatDate = (dateObj) => {
            if (!dateObj) return 'N/A';
            // objet date utilisé pendant le formatage
            const d = new Date(dateObj);
            if (isNaN(d.getTime())) return 'N/A';
            return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth()+1).padStart(2, '0')}-${d.getFullYear()}`;
        };

        // liste des fichiers préparée pour cette opération
        const files = filesRes.rows.map(row => {
            // liste des tags obtenue après la lecture de leur valeur
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

// crée un portail avec son root folder et ses cartes choisies
// génère ensuite son slug et son url de consultation
app.post('/add_portal', loginRequiredJson, async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        const { name, access = 'Public', folders, linked_folder_ids, root_folder_id } = req.body;
        if (!name) return res.status(400).json({ status: "error", message: "Name is required" });
        // résultat utilisé pour vérifier les données dans postgresql
        const existRes = await pool.query("SELECT id FROM portals WHERE name = $1;", [name]);
        if (existRes.rows.length > 0) return res.status(400).json({ status: "error", message: "Portal with this name already exists" });

        // valeur json reçue avant sa normalisation
        const raw = JSON.parse(folders || linked_folder_ids || "[]");
        // folders choisis et normalisés pour le portail
        const chosenFolders = raw.map(item =>
            (item && typeof item === 'object')
                ? { id: parseInt(item.id), size: item.size || 'standard' }
                : { id: parseInt(item), size: 'standard' }
        );

        if (root_folder_id && chosenFolders.length > 0) {
            // données de folders ou de classement renvoyées par la requête sql
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

        // ligne créée et renvoyée par postgresql
        const insertRes = await pool.query(`
            INSERT INTO portals (name, url, access, creation_date, last_sync, root_folder_id)
            VALUES ($1, '', $2, CURRENT_DATE, CURRENT_DATE, $3) RETURNING id;
        `, [name, access, root_folder_id ? parseInt(root_folder_id) : null]);

        // identifiant du portail actuellement traité
        const portal_id = insertRes.rows[0].id;
        for (const f of chosenFolders) {
            await pool.query("INSERT INTO portal_folders (portal_id, folder_id, display_size) VALUES ($1, $2, $3);", [portal_id, f.id, f.size]);
        }
        // texte court utilisé dans l’url du portail
        const slug = generateSlug(name, portal_id);
        // information réseau utilisée pour host
        const host = req.get('host');
        // information réseau utilisée pour protocol
        const protocol = req.protocol;
        // adresse utilisée pour full url
        const fullUrl = `${protocol}://${host}/portal/${slug}`;
        await pool.query("UPDATE portals SET slug = $1, url = $2 WHERE id = $3;", [slug, fullUrl, portal_id]);
        await updatePortalStats(portal_id);
        res.json({ status: "success", message: "Portal created successfully", portal_id });
    } catch (error) {
        console.error("Erreur add_portal:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// met à jour les informations générales enregistrées pour un portail
app.post('/update_portal/:portal_id', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        // identifiant du portail ou du parent en cours de traitement
        const pId = req.params.portal_id;
        // valeurs récupérées dans le corps de la requête
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

// supprime les fichiers associés puis la ligne du portail
// retourne une erreur lorsque le portail demandé n’existe pas
app.post('/delete_portal/:portal_id', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        // identifiant du portail ou du parent en cours de traitement
        const pId = req.params.portal_id;
        await pool.query("DELETE FROM portal_files WHERE portal_id = $1;", [pId]);
        // ligne supprimée et renvoyée par postgresql
        const delRes = await pool.query("DELETE FROM portals WHERE id = $1 RETURNING name;", [pId]);

        if (delRes.rows.length > 0) {
            insightsClient.trackEvent({
            name: "portal deleted",
            properties: {
                portal_name: delRes.rows[0].name,
                user: getAuditUser(req)
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

// renvoie une liste simple des identifiants et noms de portails
app.get('/get_portals', loginRequiredJson, async (req, res) => {
    try {
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query("SELECT id, name FROM portals ORDER BY name;");
        // portails mis au format attendu par l’interface
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

// affecte un fichier au portail et au folder transmis
// contrôle ensuite que le fichier reste sous le root folder du portail
app.post('/update_file_portal', loginRequiredJson, basicAdminRequired, upload.none(), async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        const { filename, portal_id, folder_id } = req.body;
        if (!filename) return res.status(400).json({ status: "error", message: "Required file name" });

        if (folder_id && folder_id !== "none" && folder_id !== "") {
            // contrôle que le folder proposé appartient bien au portail choisi
            const linkedFolderCheck = await pool.query(`
                SELECT 1
                FROM portal_folders
                WHERE portal_id = $1 AND folder_id = $2
                LIMIT 1;
            `, [portal_id, parseInt(folder_id, 10)]);
            if (linkedFolderCheck.rows.length === 0) {
                return res.status(400).json({
                    status: "error",
                    message: "The selected folder is not linked to this portal"
                });
            }
            await pool.query("UPDATE documents SET folder_id = $1 WHERE nom_fichier = $2;", [parseInt(folder_id, 10), filename]);
        }

        // données des portails renvoyées par la requête sql
        const portalCheck = await pool.query("SELECT root_folder_id, name FROM portals WHERE id = $1;", [portal_id]);
        if (portalCheck.rows.length > 0 && portalCheck.rows[0].root_folder_id) {
            // identifiant du root folder du portail
            const root_id = portalCheck.rows[0].root_folder_id;
            // nom du portail en cours de traitement
            const portalName = portalCheck.rows[0].name;
            // données de fichiers renvoyées par la requête sql
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
                // nom du folder actuellement traité
                const folder_name = fileCheck.rows[0].folder_name || "Root";
                return res.status(400).json({
                    status: "error",
                    message: `⚠️ Cannot assign to portal: This file is in folder '${folder_name}' which is outside of the portal's Root Folder hierarchy (${portalName}).`
                });
            }
        }

        // résultat utilisé pour vérifier les données dans postgresql
        const exist = await pool.query("SELECT id FROM portal_files WHERE filename = $1 AND portal_id = $2;", [filename, portal_id]);
        if (exist.rows.length > 0) return res.json({ status: "success", message: "File already in portal" });
        // données de fichiers renvoyées par la requête sql
        const docRes = await pool.query(`
            SELECT nom_fichier, lien_telechargement, description, tags, date_ajout, date_event
            FROM documents WHERE nom_fichier = $1;
        `, [filename]);
        if (docRes.rows.length === 0) return res.status(404).json({ status: "error", message: "File not found" });
        // document actuellement traité
        const doc = docRes.rows[0];
        // extension du fichier actuellement traité
        const ext = require('path').extname(filename).toLowerCase();

        // catégorie technique enregistrée pour le fichier
        let file_type = "Other";
        if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) file_type = "Image";
        else if (['.mp4', '.mov', '.avi', '.wmv'].includes(ext)) file_type = "Video";
        else if (['.pdf'].includes(ext)) file_type = "PDF";
        else if (['.doc', '.docx'].includes(ext)) file_type = "Document";
        else if (['.xls', '.xlsx'].includes(ext)) file_type = "Spreadsheet";
        // client azure qui agit sur le blob du fichier courant
        const blockBlobClient = containerClient.getBlockBlobClient(filename);
        // propriétés du blob récupérées depuis azure
        const props = await blockBlobClient.getProperties();
        // taille utilisée pour size bytes
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

// renvoie les fichiers explicitement associés au portail demandé
app.get('/get_portal_files/:portal_id', loginRequiredJson, async (req, res) => {
    try {
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query("SELECT filename FROM portal_files WHERE portal_id = $1;", [req.params.portal_id]);
        res.json({ files: result.rows.map(r => r.filename) });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

// renvoie les compteurs et les informations résumées du portail
app.get('/portal/:portal_id/stats', loginRequiredJson, async (req, res) => {
    try {
        // compteurs recalculés pour le portail
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

// supprime uniquement l’association entre un fichier et un portail
app.post('/remove_file_from_portal', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        const { filename, portal_id } = req.body;
        if (!filename || !portal_id) return res.status(400).json({ status: "error", message: "Missing params" });

        await pool.query("DELETE FROM portal_files WHERE filename = $1 AND portal_id = $2;", [filename, portal_id]);
        await updatePortalStats(portal_id);
        insightsClient.trackEvent({
            name: "remove_file_from_portal",
            properties: {
                file: filename,
                user: getAuditUser(req)
            }
        });
        res.json({ status: "success" });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

// affiche la page de connexion propre au portail demandé
app.get('/portal/:portal_id/login', async (req, res) => {
    try {
        // identifiant ou slug utilisé pour retrouver le portail
        const identifier = req.params.portal_id;
        // portail actuellement traité
        const portal = await getPortalInfo(identifier);
        if (!portal) return res.status(404).send("Portal not found");
        // identifiant réel du portail après la recherche par slug
        const real_portal_id = portal.id;
        // texte court utilisé dans l’url du portail
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

// vérifie le compte client et son mot de passe bcrypt
// crée une session limitée au portail si les données sont valides
app.post('/portal/:portal_id/login', loginLimiter, upload.none(), async (req, res) => {
    try {
        // identifiant ou slug utilisé pour retrouver le portail
        const identifier = req.params.portal_id;
        // portail actuellement traité
        const portal = await getPortalInfo(identifier);
        if (!portal) return res.status(404).send("Portal not found");
        // identifiant réel du portail après la recherche par slug
        const real_portal_id = portal.id;
        // texte court utilisé dans l’url du portail
        const slug = portal.slug || real_portal_id;
        // valeurs récupérées dans le corps de la requête
        const { email, password, reset_request, reset_email } = req.body;
        if (reset_request !== undefined) {
            // comptes utilisateurs renvoyés par la requête sql
            const userRes = await pool.query("SELECT id FROM portal_users WHERE email = LOWER($1) AND portal_id = $2;", [reset_email, real_portal_id]);
            if (userRes.rows.length > 0) {
                // jeton utilisé pour l’opération en cours
                const token = require('crypto').randomBytes(32).toString('hex');
                // valeur de date utilisée pour expiry
                const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
                await pool.query("UPDATE portal_users SET reset_token = $1, reset_token_expiry = $2 WHERE email = $3 AND portal_id = $4;",
                    [token, expiry, reset_email, real_portal_id]);
                // adresse utilisée pour reset url
                const resetUrl = `${req.protocol}://${req.get('host')}/portal/${slug}/reset_password/${token}`;
                await sendEmail(reset_email, "Resetting your password", `Click here: ${resetUrl}`);
                return res.render('portal_login.html', { portal_id: slug, portal_name: portal.name, error: "Reset email sent!" });
            }
        }

        // indique si les identifiants donnent accès au portail
        const authorized = await checkPortalAccess(email, real_portal_id, password);
        if (authorized) {
            // comptes utilisateurs renvoyés par la requête sql
            const user = await pool.query("SELECT id FROM portal_users WHERE email = $1 AND portal_id = $2;", [email, real_portal_id]);
            req.session.portal_user_id = user.rows[0].id;
            req.session.portal_user_email = email;
            req.session.portal_access = real_portal_id;
            await pool.query("UPDATE portal_users SET last_login = NOW() WHERE id = $1;", [user.rows[0].id]);
            if (insightsClient) {
                insightsClient.trackEvent({
                    name: "portal_login_success",
                    properties: {
                        user: email,
                        portal: portal.name
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

// affiche le formulaire si le jeton de reset est encore valide
app.get('/portal/:portal_id/reset_password/:token', async (req, res) => {
    // identifiant ou slug utilisé pour retrouver le portail
    const identifier = req.params.portal_id;
    // jeton extrait des paramètres de la route
    const { token } = req.params;

    // portail actuellement traité
    const portal = await getPortalInfo(identifier);
    if (!portal) return res.status(404).send("Portail introuvable.");

    // lignes renvoyées par la requête sql en cours
    const result = await pool.query(
        "SELECT id, email FROM portal_users WHERE reset_token = $1 AND reset_token_expiry > NOW() AND portal_id = $2;",
        [token, portal.id]
    );

    if (result.rows.length === 0) return res.send("Lien invalide ou expiré.");

    // texte court utilisé dans l’url du portail
    const slug = portal.slug || portal.id;
    res.render('portal_reset_password.html', { portal_id: slug, token, email: result.rows[0].email });
});

// enregistre le nouveau mot de passe puis invalide le jeton utilisé
app.post('/portal/:portal_id/reset_password/:token', upload.none(), async (req, res) => {
    // identifiant ou slug utilisé pour retrouver le portail
    const identifier = req.params.portal_id;
    // jeton extrait des paramètres de la route
    const { token } = req.params;
    // valeurs récupérées dans le corps de la requête
    const { password, confirm_password } = req.body;

    if (password !== confirm_password) return res.send("Passwords do not match");

    // portail actuellement traité
    const portal = await getPortalInfo(identifier);
    if (!portal) return res.status(404).send("Portail introuvable.");

    // mot de passe chiffré avec bcrypt avant son enregistrement
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
        "UPDATE portal_users SET password = $1, reset_token = NULL, reset_token_expiry = NULL WHERE reset_token = $2 AND portal_id = $3;",
        [hashedPassword, token, portal.id]
    );

    // texte court utilisé dans l’url du portail
    const slug = portal.slug || portal.id;
    res.redirect(`/portal/${slug}/login`);
});

// affiche le formulaire de demande de nouveau mot de passe
app.get('/portal/:portal_id/request_reset', async (req, res) => {
    try {
        // identifiant ou slug utilisé pour retrouver le portail
        const identifier = req.params.portal_id;
        // portail actuellement traité
        const portal = await getPortalInfo(identifier);
        if (!portal) {
            req.flash('error', 'Portal not found');
            return res.redirect('/portals');
        }
        // texte court utilisé dans l’url du portail
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

// crée un jeton temporaire pour le compte client demandé
// envoie par email le lien permettant de choisir un nouveau mot de passe
app.post('/portal/:portal_id/request_reset', loginLimiter, upload.none(), async (req, res) => {
    // identifiant ou slug utilisé pour retrouver le portail
    const identifier = req.params.portal_id;
    // adresse email utilisée pour email
    const email = req.body.email ? req.body.email.toLowerCase().trim() : '';
    try {
        // portail actuellement traité
        const portal = await getPortalInfo(identifier);
        if (!portal) {
            req.flash('error', 'Portal not found');
            return res.redirect('/portals');
        }
        // identifiant réel du portail après la recherche par slug
        const real_portal_id = portal.id;
        // texte court utilisé dans l’url du portail
        const slug = portal.slug || real_portal_id;
        // comptes utilisateurs renvoyés par la requête sql
        const userRes = await pool.query(
            "SELECT id FROM portal_users WHERE email = $1 AND portal_id = $2;",
            [email, real_portal_id]
        );
        if (userRes.rows.length > 0) {
            // jeton utilisé pour l’opération en cours
            const token = require('crypto').randomBytes(32).toString('hex');
            // valeur de date utilisée pour expiry
            const expiry = new Date();
            expiry.setHours(expiry.getHours() + 24);
            await pool.query(
                "UPDATE portal_users SET reset_token = $1, reset_token_expiry = $2 WHERE email = $3 AND portal_id = $4;",
                [token, expiry, email, real_portal_id]
            );
            // adresse utilisée pour reset url
            const resetUrl = `${req.protocol}://${req.get('host')}/portal/${slug}/reset_password/${token}`;
            // objet utilisé pour l’email de réinitialisation
            const subject = `Resetting your password - ${portal.name}`;
            // données reçues pour body
            const body = `Hello,

                          You have requested to reset your password for the ${portal.name} portal.

                          Please click the following link to set a new password:

                          ${resetUrl}

                          This link will expire in 24 hours.

                          Sincerely,
                          The Media Library Team`;

            // adresse email utilisée pour email sent
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

// supprime les informations de session propres au portail client
app.get('/logout_portal', (req, res) => {
    // identifiant du portail ou du parent en cours de traitement
    const pId = req.session.portal_access;
    if (req.session.user_email && req.session.user_email.endsWith('@pur.co')) {
        return res.redirect('/portals');
    }
    req.session.destroy();
    res.redirect(pId ? `/portal/${pId}/login` : '/');
});

// déconnecte le client du portail sans supprimer une session interne
// retourne l’adresse vers laquelle le navigateur doit revenir
app.post('/portal/:portal_id/logout', (req, res) => {
    // identifiant du portail actuellement traité
    const portal_id = req.params.portal_id;
    // adresse email utilisée pour user email to log
    const userEmailToLog = getAuditUser(req);
    if (req.session.user_email) {
        delete req.session.portal_user_id;
        delete req.session.portal_user_email;
        delete req.session.portal_access;
        // répond après l’enregistrement complet de la session portail
        req.session.save(() => {
            if (insightsClient) {
                insightsClient.trackEvent({
                    name: "logout_from_portal",
                    properties: {
                        portal: portal_id,
                        user: userEmailToLog
                    }
                });
            }
            res.json({ status: "success", redirect_url: "/portals" });
        });
        return;
    }
    // termine la déconnexion client après destruction de la session
    req.session.destroy((err) => {
        if (err) {
            console.error("Erreur destruction session:", err);
            return res.status(500).json({ status: "error" });
        }
        if (insightsClient) {
            insightsClient.trackEvent({
                name: "logout_from_portal",
                properties: {
                    portal: portal_id,
                    user: userEmailToLog
                }
            });
        }
        res.json({ status: "success", redirect_url: `/portal/${portal_id}/login` });
    });
});

// renvoie le slug enregistré pour le portail demandé
app.get("/get_portal_slug/:portal_id", async (req, res) => {
    try {
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query("SELECT slug FROM portals WHERE id = $1;", [req.params.portal_id]);
        if (result.rows.length > 0 && result.rows[0].slug) {
            return res.json({ status: "success", slug: result.rows[0].slug });
        }
        res.status(404).json({ status: "error", message: "Slug not found" });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

// construit l’adresse de connexion complète du portail demandé
app.get('/get_portal_url/:portal_id', loginRequiredJson, async (req, res) => {
    try {
        // identifiant du portail actuellement traité
        const portal_id = req.params.portal_id;
        if (!portal_id) return res.status(400).json({ status: "error", message: "ID manquant" });
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query("SELECT slug FROM portals WHERE id = $1;", [portal_id]);
        // texte court utilisé dans l’url du portail
        const slug = (result.rows.length > 0 && result.rows[0].slug) ? result.rows[0].slug : portal_id;
        // information réseau utilisée pour host
        const host = req.get('host');
        // information réseau utilisée pour protocol
        const protocol = req.protocol;
        // adresse utilisée pour portal url
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

// affiche la page admin qui gère les comptes des portails clients
app.get('/admin/users', loginRequiredHtml, adminRequired, async (req, res) => {
    try {
        // comptes utilisateurs renvoyés par la requête sql
        const usersResult = await pool.query(`
            SELECT pu.id, pu.email, pu.last_login, p.name as portal_name, p.id as portal_id
            FROM portal_users pu
            JOIN portals p ON pu.portal_id = p.id
            ORDER BY pu.email ASC;
        `);
        // données des portails renvoyées par la requête sql
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

// crée un compte client avec un mot de passe bcrypt
// refuse un email déjà présent dans le même portail
app.post('/admin/add_user', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        const { email, password, portal_id } = req.body;
        if (!email || !password || !portal_id) {
            return res.status(400).json({ status: "error", message: "Email, password and portal are required." });
        }
        // adresse email utilisée pour safe email
        const safeEmail = email.toLowerCase().trim();
        // résultat utilisé pour vérifier les données dans postgresql
        const checkRes = await pool.query("SELECT id FROM portal_users WHERE email = $1 AND portal_id = $2;", [safeEmail, portal_id]);
        if (checkRes.rows.length > 0) {
            return res.status(400).json({ status: "error", message: "This user already has access to this portal." });
        }
        // mot de passe chiffré avec bcrypt avant son enregistrement
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            "INSERT INTO portal_users (email, password, portal_id) VALUES ($1, $2, $3);",
            [safeEmail, hashedPassword, portal_id]
        );
        if (typeof insightsClient !== 'undefined' && insightsClient) {
            insightsClient.trackEvent({
                name: "admin_user_added",
                properties: { email_cible: safeEmail, admin: getAuditUser(req) }
            });
        }
        res.json({ status: "success", message: "user created successfully" });
    } catch (error) {
        console.error("Erreur add_user:", error);
        res.status(500).json({ status: "error", message: "Error creating user" });
    }
});

// remplace le mot de passe bcrypt du compte client demandé
app.post('/admin/update_password', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        const { user_id, new_password } = req.body;
        if (!user_id || !new_password) {
            return res.status(400).json({ status: "error", message: "Username and new password required" });
        }

        // mot de passe chiffré avec bcrypt avant son enregistrement
        const hashedPassword = await bcrypt.hash(new_password, 10);
        await pool.query("UPDATE portal_users SET password = $1 WHERE id = $2;", [hashedPassword, user_id]);

        res.json({ status: "success", message: "The password has been updated" });
    } catch (error) {
        console.error("Erreur update_password:", error);
        res.status(500).json({ status: "error", message: "Server error during update" });
    }
});

// supprime le compte client choisi par son identifiant
app.post('/admin/delete_user', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ status: "error", message: "Missing user ID" });

        await pool.query("DELETE FROM portal_users WHERE id = $1;", [user_id]);

        if (typeof insightsClient !== 'undefined' && insightsClient) {
            insightsClient.trackEvent({
                name: "admin_user_deleted",
                properties: { admin: getAuditUser(req) }
            });
        }
        res.json({ status: "success", message: "User access has been revoked" });
    } catch (error) {
        console.error("Erreur delete_user:", error);
        res.status(500).json({ status: "error", message: "Server error during deletion." });
    }
});


// module utilisé pour télécharger une adresse https
const https = require('https');
// transfère un fichier distant vers le navigateur connecté
// limite un compte client aux fichiers visibles dans son portail
app.get('/proxy_download', portalOrInternalRequiredJson, async (req, res) => {
    // adresse utilisée pour file url
    const fileUrl = req.query.url;
    // nom utilisé pour retrouver ou enregistrer le fichier
    const filename = req.query.filename || "file";
    if (!fileUrl) return res.status(400).send("URL missing");

    try {
        // adresse validée avant de démarrer la requête https
        const parsedUrl = new URL(fileUrl);
        if (parsedUrl.protocol !== 'https:') {
            return res.status(400).send("Only HTTPS downloads are allowed");
        }

        if (!req.session.user_email) {
            // identifiant du portail auquel le compte client est connecté
            const portalAccessId = parseInt(req.session.portal_access, 10);
            if (!Number.isInteger(portalAccessId)) {
                return res.status(403).json({ status: "error", error: "Portal access denied" });
            }

            // contrôle le lien direct et les descendants des folders visibles
            const visibilityCheck = await pool.query(`
                WITH RECURSIVE allowed_folders AS (
                    SELECT id
                    FROM folders
                    WHERE id = (SELECT root_folder_id FROM portals WHERE id = $1)

                    UNION

                    SELECT folder_id AS id
                    FROM portal_folders
                    WHERE portal_id = $1
                      AND (SELECT root_folder_id FROM portals WHERE id = $1) IS NULL

                    UNION ALL

                    SELECT f.id
                    FROM folders f
                    INNER JOIN allowed_folders af ON f.parent_id = af.id
                )
                SELECT EXISTS (
                    SELECT 1
                    FROM portal_files pf
                    WHERE pf.portal_id = $1 AND pf.file_url = $2

                    UNION ALL

                    SELECT 1
                    FROM documents d
                    WHERE d.lien_telechargement = $2
                      AND d.folder_id IN (SELECT id FROM allowed_folders)
                ) AS allowed;
            `, [portalAccessId, fileUrl]);

            if (!visibilityCheck.rows[0]?.allowed) {
                return res.status(403).json({ status: "error", error: "File is not available in this portal" });
            }
        }

        // heure de départ utilisée pour calculer la durée
        const startTime = Date.now();

        // relaie la réponse du serveur distant vers le navigateur
        https.get(parsedUrl, (response) => {
            res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
            response.pipe(res);

            // calcule les statistiques quand le transfert se termine
            res.on('finish', () => {
                // durée totale du téléchargement en millisecondes
                const duration = Date.now() - startTime;
                // taille du fichier exprimée en octets
                const sizeBytes = parseInt(response.headers['content-length'] || 0, 10);
                // vitesse moyenne calculée en mégabits par seconde
                const speedMbps = sizeBytes > 0 && duration > 0 ? ((sizeBytes * 8) / (duration / 1000) / (1024 * 1024)).toFixed(2) : "0.00";

                if (insightsClient) {
                    insightsClient.trackEvent({
                        name: "file_download",
                        properties: {
                            filename: filename,
                            duration_ms: duration,
                            size_bytes: sizeBytes,
                            speed_mbps: speedMbps,
                            user: getAuditUser(req)
                        }
                    });
                }
            });
        // renvoie une erreur si le téléchargement distant échoue
        }).on('error', (error) => {
            console.error("Proxy download error:", error);
            if (!res.headersSent) res.status(500).send("Erreur de téléchargement du fichier.");
            else res.destroy(error);
        });
    } catch (error) {
        console.error("Proxy download validation error:", error);
        if (!res.headersSent) res.status(500).send("Erreur de téléchargement du fichier.");
    }
});

// renvoie les sections et catégories disponibles dans les documents
app.get('/get_filters_data', loginRequiredJson, async (req, res) => {
    try {
        // données de folders ou de classement renvoyées par la requête sql
        const sections = await pool.query("SELECT DISTINCT section FROM documents WHERE section IS NOT NULL AND section != '' ORDER BY section ASC;");
        // données de folders ou de classement renvoyées par la requête sql
        const categories = await pool.query("SELECT DISTINCT category FROM documents WHERE category IS NOT NULL AND category != '' ORDER BY category ASC;");
        res.json({
            sections: sections.rows.map(r => r.section),
            categories: categories.rows.map(r => r.category)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// renvoie la liste des fichiers du folder et de tous ses descendants
// le navigateur utilise ensuite cette liste pour construire le zip
app.get('/api/export_folder_zip/:folder_id', loginRequiredJson, async (req, res) => {
    try {
        // identifiant du folder choisi comme destination
        const targetFolderId = parseInt(req.params.folder_id);
        // données de folders ou de classement renvoyées par la requête sql
        const foldersRes = await pool.query("SELECT id, name, parent_id FROM folders");
        // liste des folders préparée pour cette opération
        const folders = foldersRes.rows;
        // table de correspondance utilisée pour folder map
        const folderMap = new Map();
        folders.forEach(f => folderMap.set(f.id, f));
        // folder choisi comme destination de l’opération
        const targetFolder = folderMap.get(targetFolderId);
        if (!targetFolder) return res.status(404).json({ status: "error", message: "Dossier introuvable" });
        // liste utilisée pour descendants
        const descendants = [];
        // chemins calculés pour les folders du fichier zip
        const paths = new Map();

        // parcourt les folders enfants de manière récursive
        // ajoute chaque descendant à la liste utilisée par la route
        function getDescendants(parentId, currentPath) {
            // folders enfants trouvés pendant le parcours récursif
            const children = folders.filter(f => f.parent_id === parentId);
            // ajoute le chemin de chaque enfant avant de continuer récursivement
            children.forEach(c => {
                // outil utilisé pour construire et lire les chemins de fichiers
                const path = `${currentPath}/${c.name}`;
                paths.set(c.id, path);
                descendants.push(c.id);
                getDescendants(c.id, path);
            });
        }

        paths.set(targetFolderId, targetFolder.name);
        descendants.push(targetFolderId);
        getDescendants(targetFolderId, targetFolder.name);
        // données de fichiers renvoyées par la requête sql
        const filesRes = await pool.query(
            "SELECT nom_fichier, lien_telechargement, folder_id FROM documents WHERE folder_id = ANY($1::int[])",
            [descendants]
        );
        // fichiers et chemins renvoyés pour construire le zip
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

// ajoute ou retire le fichier des favoris de l’utilisateur connecté
// retourne le nouvel état pour mettre le cœur à jour sans recharger
app.post('/toggle_favorite', portalOrInternalRequiredJson, upload.none(), async (req, res) => {
    try {
        // nom utilisé pour retrouver ou enregistrer le fichier
        const filename = req.body.filename;
        // adresse email utilisée pour user email
        const user_email = req.session.user_email || req.session.portal_user_email;
        if (!filename || !user_email) {
            return res.status(400).json({ status: "error", message: "Missing settings" });
        }
        // résultat utilisé pour vérifier les données dans postgresql
        const checkRes = await pool.query(
            "SELECT id FROM user_favorites WHERE user_email = $1 AND filename = $2;",
            [user_email, filename]
        );
        // indique si le fichier est déjà dans les favoris
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

// renvoie les noms des fichiers favoris de l’utilisateur connecté
app.get('/my_favorites', portalOrInternalRequiredJson, async (req, res) => {
    try {
        // adresse email utilisée pour user email
        const user_email = req.session.user_email || req.session.portal_user_email;
        if (!user_email) return res.json({ status: "success", favorites: [] });
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query(
            "SELECT filename FROM user_favorites WHERE user_email = $1;",
            [user_email]
        );
        // liste utilisée pour favorites list
        const favoritesList = result.rows.map(row => row.filename);
        res.json({ status: "success", favorites: favoritesList });
    } catch (error) {
        console.error("Erreur my_favorites:", error);
        res.status(500).json({ status: "error", favorites: [] });
    }
});

// remplace les cartes de folder liées au portail
// vérifie leur présence sous le root folder avant de les enregistrer
app.post('/link_portal_to_folder', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        const { portal_id, folders, folder_ids, root_folder_id } = req.body;
        // valeur json reçue avant sa normalisation
        const raw = JSON.parse(folders || folder_ids || "[]");
        // folders reçus puis normalisés pour la mise à jour
        const chosen = raw.map(item =>
            (item && typeof item === 'object')
                ? { id: parseInt(item.id), size: item.size || 'standard' }
                : { id: parseInt(item), size: 'standard' }
        );

        if (root_folder_id) {
            if (chosen.length > 0) {
                // données de folders ou de classement renvoyées par la requête sql
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

            // données de fichiers renvoyées par la requête sql
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
                // fichier trouvé en dehors du root folder autorisé
                const offendingFile = checkFilesRes.rows[0].filename;
                // folder non autorisé contenant ce fichier
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

        // résultat utilisé pour vérifier les données dans postgresql
        const existingRes = await pool.query("SELECT * FROM portal_folders WHERE portal_id = $1;", [portal_id]);
        // table de correspondance utilisée pour existing layouts
        const existingLayouts = new Map();
        // mémorise l’ancienne mise en page de chaque folder
        existingRes.rows.forEach(row => {
            existingLayouts.set(row.folder_id, row);
        });
        await pool.query("DELETE FROM portal_folders WHERE portal_id = $1;", [portal_id]);
        for (const f of chosen) {
            // ancienne mise en page conservée pour ce folder
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

// renvoie les folders liés, leur taille et le root folder du portail
// sert à restaurer les choix dans les modales d’administration
app.get('/portal_folders/:portal_id', loginRequiredJson, async (req, res) => {
    try {
        // données des portails renvoyées par la requête sql
        const portalRes = await pool.query("SELECT root_folder_id FROM portals WHERE id = $1;", [req.params.portal_id]);
        // identifiant de folder utilisé pour root folder id
        const root_folder_id = portalRes.rows.length > 0 ? portalRes.rows[0].root_folder_id : null;
        // lignes renvoyées par la requête sql en cours
        const result = await pool.query(`
            SELECT pf.folder_id, pf.display_size, f.name AS folder_name
            FROM portal_folders pf
            JOIN folders f ON f.id = pf.folder_id
            WHERE pf.portal_id = $1
            ORDER BY pf.position ASC NULLS LAST, f.name ASC;
        `, [req.params.portal_id]);
        res.json({ status: "success", folders: result.rows, root_folder_id: root_folder_id });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

// met à jour un champ du document et sa copie dans portal_files
// traite séparément le nom, les dates, les tags et le json métier
app.post('/update_file_metadata', loginRequiredHtml, basicAdminRequired, async (req, res) => {
    try {
        // valeurs récupérées dans le corps de la requête
        let { original_filename, field, value } = req.body;
        if (!original_filename || !field) return res.status(400).json({ status: 'error', message: 'param missing' });
        if (field === 'filename') {
            // données de fichiers renvoyées par la requête sql
            const checkDocs = await pool.query("SELECT * FROM documents WHERE nom_fichier = $1", [value]);
            // données des portails renvoyées par la requête sql
            const checkPortal = await pool.query("SELECT * FROM portal_files WHERE filename = $1", [value]);

            if (checkDocs.rows.length > 0 || checkPortal.rows.length > 0) {
                return res.status(409).json({ status: 'error', message: 'This filename already exists.' });
            }
        }
        // colonne documents à modifier pour le champ demandé
        let dbFieldDoc = '';
        // colonne portal_files à modifier pour le champ demandé
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
            // valeur de date utilisée pour date parts
            const dateParts = value.split('-');
            if (dateParts.length === 3) {
                if (dateParts[0].length <= 2) {
                    value = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
                }
            }
        }
        if (field === 'tags') {
            // liste utilisée pour tags array
            const tagsArray = String(value || '').split(',').map(t => t.trim()).filter(t => t.length > 0);
            await pool.query(`UPDATE documents SET tags = $1 WHERE nom_fichier = $2`, [JSON.stringify(tagsArray), original_filename]);
        }
        else if (field === 'metadata') {
            // objet qui regroupe les métadonnées pour metadata obj
            let metadataObj = {};
            try {
                metadataObj = typeof value === 'string' ? JSON.parse(value) : value;
            } catch (e) {
                return res.status(400).json({ status: 'error', message: 'Invalid JSON for metadata' });
            }

            // indique si la session possède le rôle admin complet
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


// crée un lien public temporaire pour les fichiers sélectionnés
// enregistre les noms et une expiration de trente jours
app.post('/create_share_link', loginRequiredJson, upload.none(), async (req, res) => {
    try {
        // liste des noms de fichiers à traiter
        let filenames;
        try { filenames = JSON.parse(req.body.filenames || '[]'); } catch { filenames = []; }

        if (!Array.isArray(filenames) || filenames.length === 0) {
            return res.status(400).json({ status: 'error', message: 'No files specified.' });
        }

        // paramètres préparés pour exécuter la requête sans concaténer les valeurs
        const ph = filenames.map((_, i) => `$${i + 1}`).join(', ');
        // résultat utilisé pour vérifier les données dans postgresql
        const check = await pool.query(
            `SELECT nom_fichier FROM documents WHERE nom_fichier IN (${ph})`, filenames
        );
        if (check.rows.length === 0) {
            return res.status(404).json({ status: 'error', message: 'No matching files found.' });
        }

        // jeton utilisé pour l’opération en cours
        const token = crypto.randomBytes(18).toString('base64url').slice(0, 24);

        await pool.query(
            `INSERT INTO shared_links (token, filenames, created_by, expires_at)
             VALUES ($1, $2::jsonb, $3, NOW() + INTERVAL '30 days')`,
            [token, JSON.stringify(filenames), req.session.user_email || null]
        );

        // adresse utilisée pour share url
        const shareUrl = `${req.protocol}://${req.get('host')}/s/${token}`;
        res.json({ status: 'success', token, url: shareUrl });

    } catch (err) {
        console.error('create_share_link error:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// affiche la page publique correspondant au jeton de partage
// refuse le lien lorsqu’il manque, expire ou ne contient plus de fichier
app.get('/s/:token', async (req, res) => {
    try {
        // jeton extrait des paramètres de la route
        const { token } = req.params;
        // lignes renvoyées par la requête sql en cours
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

        // élément actuellement traité pour row
        const row = result.rows[0];
        if (new Date(row.expires_at) < new Date()) {
            return res.status(410).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Link expired — PUR</title>
                <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f4f7;margin:0;}
                .box{text-align:center;padding:48px;background:white;border-radius:20px;box-shadow:0 8px 32px rgba(0,0,0,.1);}
                h2{color:#f59e0b;margin-bottom:12px;}p{color:#64748b;}</style></head>
                <body><div class="box"><h2>⏰ Link expired</h2><p>This share link expired on ${new Date(row.expires_at).toLocaleDateString()}.</p></div></body></html>`);
        }

        // liste des noms de fichiers à traiter
        const filenames = row.filenames;
        if (filenames.length === 0) return res.status(404).send('No files.');

        // paramètres préparés pour exécuter la requête sans concaténer les valeurs
        const ph2 = filenames.map((_, i) => `$${i + 1}`).join(', ');
        // données de fichiers renvoyées par la requête sql
        const filesResult = await pool.query(
            `SELECT nom_fichier AS name, lien_telechargement AS url, description, tags, date_ajout, date_event FROM documents WHERE nom_fichier IN (${ph2})`,
            filenames
        );

        // liste des fichiers préparée pour cette opération
        const files = filesResult.rows;
        // date de création formatée pour la page publique
        const createdAt = new Date(row.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        // date d’expiration formatée pour la page publique
        const expiresAt = new Date(row.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

        // formate une date pour la page publique de partage
        // retourne une valeur vide lorsque la date est inutilisable
        const formatShareDate = (dateObj) => {
            if (!dateObj) return "Not specified";
            // objet date utilisé pendant le formatage
            const d = new Date(dateObj);
            if (isNaN(d.getTime())) return "Not specified";
            // jour extrait de la date
            const day = String(d.getDate()).padStart(2, '0');
            // mois extrait de la date
            const month = String(d.getMonth() + 1).padStart(2, '0');
            // année extraite de la date
            const year = d.getFullYear();
            return `${day}/${month}/${year}`;
        };

        // cartes html préparées pour les fichiers partagés
        const fileCards = files.map(f => {
            // extension du fichier actuellement traité
            const ext = (f.name.split('.').pop() || '').toLowerCase();
            // indique si le fichier est une image affichable
            const isImg = ['jpg','jpeg','png','gif','webp','svg'].includes(ext);
            // indique si le fichier est une vidéo affichable
            const isVideo = ['mp4','mov','webm','avi'].includes(ext);

            // nom de fichier sécurisé avant son utilisation
            const safeName = f.name.replace(/"/g, '&quot;');
            // description échappée avant son insertion dans le html
            const safeDesc = (f.description || '').replace(/"/g, '&quot;');

            // liste des tags obtenue après la lecture de leur valeur
            let parsedTags = [];
            try {
                if (typeof f.tags === 'string') parsedTags = JSON.parse(f.tags);
                else if (Array.isArray(f.tags)) parsedTags = f.tags;
            } catch(e) {}
            // tags échappés avant leur insertion dans le html
            const safeTags = JSON.stringify(parsedTags).replace(/"/g, '&quot;');

            // aperçu html choisi selon le type du fichier
            const preview = isImg
                ? `<img src="${f.url}" alt="${safeName}" style="width:100%;height:175px;object-fit:cover;border-radius:12px 12px 0 0;">`
                : isVideo
                ? `<video src="${f.url}" style="width:100%;height:175px;object-fit:cover;border-radius:12px 12px 0 0;" muted></video>`
                : `<div style="height:175px;background:linear-gradient(135deg,#f0f4f7,#e8eef5);border-radius:12px 12px 0 0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#94a3b8;">
                     <span style="font-size:34px;">📄</span><span style="font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.05em;">${ext}</span>
                   </div>`;

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

    .modal-overlay { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(15, 23, 42, 0.85); z-index:9999; align-items:center; justify-content:center; padding:20px; opacity: 0; transition: opacity 0.3s ease;}
    .modal-overlay.active { display:flex; opacity: 1; }
    .modal-content { background:white; border-radius:16px; max-width:900px; width:100%; max-height:90vh; display:flex; flex-direction:column; overflow:hidden; position:relative; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);}
    .modal-close { position:absolute; top:12px; right:12px; background:#f1f5f9; border:none; border-radius:50%; width:36px; height:36px; cursor:pointer; font-size:16px; color:#475569; display:flex; align-items:center; justify-content:center; transition:background 0.2s; z-index:10;}
    .modal-close:hover { background:#e2e8f0; }
    .modal-media { background:#f8fafc; display:flex; justify-content:center; align-items:center; flex:1; overflow:hidden; min-height:40vh; position:relative; border-bottom: 1px solid #e2e8f0;}
    .modal-info { padding:24px; overflow-y:auto; max-height: 40vh; }
    .modal-tag { display:inline-block; background:#f1f5f9; color:#475569; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:600; margin: 0 6px 6px 0;}

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
    // ouvre la modale publique avec les données de la carte choisie
    // sélectionne aussi le bon aperçu selon le type de fichier
    function openModal(el) {
      // adresse utilisée pour url
      const url = el.getAttribute('data-url');
      // nom de l’élément actuellement traité
      const name = el.getAttribute('data-name');
      // description lue sur la carte sélectionnée
      const desc = el.getAttribute('data-desc');
      // extension du fichier actuellement traité
      const ext = el.getAttribute('data-ext');

      // valeur de date utilisée pour added date
      const addedDate = el.getAttribute('data-added');
      // valeur de date utilisée pour event date
      const eventDate = el.getAttribute('data-event');

      // liste des tags associés au fichier
      let tags = [];
      try {
        // tags json lus sur la carte sélectionnée
        const tagsRaw = el.getAttribute('data-tags');
        if (tagsRaw) tags = JSON.parse(tagsRaw);
      } catch(e) { console.error("Error parsing tags:", e); }

      document.getElementById('modalTitle').textContent = name;
      document.getElementById('modalDesc').textContent = desc || 'No description provided.';

      document.getElementById('modalAddedDate').textContent = addedDate;
      document.getElementById('modalEventDate').textContent = eventDate;

      // bouton de téléchargement affiché dans la modale
      const dlBtn = document.getElementById('modalDownload');
      dlBtn.href = url;
      dlBtn.download = name;

      // badges html construits avec les tags du fichier
      const tagsHtml = tags.length > 0
        ? tags.map(t => \`<span class="modal-tag">\${t}</span>\`).join('')
        : '<span style="font-size:13px;color:#94a3b8;font-style:italic;">No tags</span>';
      document.getElementById('modalTagsContainer').innerHTML = tagsHtml;

      // zone de la modale qui reçoit l’aperçu du fichier
      const mediaContainer = document.getElementById('modalMediaContainer');
      // indique si le fichier est une image affichable
      const isImg = ['jpg','jpeg','png','gif','webp','svg'].includes(ext);
      // indique si le fichier est une vidéo affichable
      const isVideo = ['mp4','mov','webm','avi'].includes(ext);
      // indique si le fichier est un audio lisible
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

      // élément html de la modale publique
      const modal = document.getElementById('mediaModal');
      modal.classList.add('active');
      document.body.style.overflow = 'hidden';
    }

    // ferme la modale publique et arrête les médias en cours
    // vide le contenu pour éviter de garder une ancienne prévisualisation
    function closeModal() {
      // élément html de la modale publique
      const modal = document.getElementById('mediaModal');
      modal.classList.remove('active');
      document.getElementById('modalMediaContainer').innerHTML = '';
      document.body.style.overflow = 'auto';
    }

    // ferme la modale publique lorsque la touche échap est pressée
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

// crée un lien public pour tous les fichiers d’une branche
// parcourt les descendants avant d’enregistrer le jeton
app.post('/api/share_folder/:folder_id', loginRequiredJson, async (req, res) => {
    try {
        // identifiant du folder choisi comme destination
        const targetFolderId = parseInt(req.params.folder_id);
        // données de folders ou de classement renvoyées par la requête sql
        const foldersRes = await pool.query("SELECT id, parent_id FROM folders");
        // liste des folders préparée pour cette opération
        const folders = foldersRes.rows;
        // liste utilisée pour descendants
        const descendants = [];
        // parcourt les folders enfants de manière récursive
        // ajoute chaque descendant à la liste utilisée par la route
        function getDescendants(parentId) {
            // folders enfants trouvés pendant le parcours récursif
            const children = folders.filter(f => f.parent_id === parentId);
            // ajoute chaque enfant puis continue le parcours récursif
            children.forEach(c => {
                descendants.push(c.id);
                getDescendants(c.id);
            });
        }
        descendants.push(targetFolderId);
        getDescendants(targetFolderId);
        // données de fichiers renvoyées par la requête sql
        const filesRes = await pool.query(
            "SELECT nom_fichier FROM documents WHERE folder_id = ANY($1::int[])",
            [descendants]
        );
        // liste des noms de fichiers à traiter
        const filenames = filesRes.rows.map(f => f.nom_fichier);
        if (filenames.length === 0) {
            return res.status(404).json({ status: "error", message: "This folder is empty." });
        }
        // jeton utilisé pour l’opération en cours
        const token = crypto.randomBytes(18).toString('base64url').slice(0, 24);
        await pool.query(
            `INSERT INTO shared_links (token, filenames, created_by, expires_at)
             VALUES ($1, $2::jsonb, $3, NOW() + INTERVAL '30 days')`,
            [token, JSON.stringify(filenames), req.session.user_email || null]
        );

        // adresse utilisée pour share url
        const shareUrl = `${req.protocol}://${req.get('host')}/s/${token}`;
        res.json({ status: 'success', token, url: shareUrl, count: filenames.length });

    } catch (error) {
        console.error("Erreur share_folder:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// ensemble des assets canto déjà en cours de traitement
const processingFiles = new Set();
// dernier jeton canto gardé en mémoire
let cachedCantoToken = null;
// date à partir de laquelle le jeton canto ne doit plus être utilisé
let tokenExpirationTime = null;

// récupère un jeton oauth canto et le garde en mémoire
// réutilise le jeton tant qu’il reste suffisamment valide
async function getCantoToken() {
    if (
        cachedCantoToken &&
        tokenExpirationTime &&
        Date.now() < tokenExpirationTime - 300000
    ) {
        return cachedCantoToken;
    }
    // domaine canto utilisé pour construire les appels api
    const cantoDomain = process.env.CANTO_DOMAIN || "";

    // information réseau utilisée pour base domain
    const baseDomain = cantoDomain.includes("canto.de") ? "canto.de" : (cantoDomain.includes("canto.global") ? "canto.global" : "canto.com");
    // adresse utilisée pour token url
    const tokenUrl = `https://oauth.${baseDomain}/oauth/api/oauth2/compatible/token`;

    // paramètres préparés pour exécuter la requête sans concaténer les valeurs
    const params = new URLSearchParams();
    params.append("app_id", process.env.CANTO_APP_ID);
    params.append("app_secret", process.env.CANTO_APP_SECRET);
    params.append("grant_type", "client_credentials");

    // données reçues pour response
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

    // données reçues pour data
    const data = await response.json();
    cachedCantoToken = data.access_token;
    tokenExpirationTime = Date.now() + data.expires_in * 1000;

    return cachedCantoToken;
}

// reçoit un asset canto puis lance son import en arrière-plan
// télécharge le fichier, copie ses métadonnées et crée sa miniature
app.post('/api/webhook/canto_sync', express.json(), async (req, res) => {
    res.status(200).send('Webhook bien reçu');

    // données reçues pour payload
    const payload = req.body || {};
    // identifiant de l’asset reçu depuis canto
    const canto_id = payload.id;
    // nom de fichier utilisé pour nom fichier
    const nom_fichier = payload.displayname;

    if (payload.secure_token !== 'motdepasse') return;
    if (!canto_id || !nom_fichier) return;

    if (processingFiles.has(canto_id)) {
        console.log(`[Auto-Sync] Doublon ignoré pour : ${nom_fichier}`);
        return;
    }
    processingFiles.add(canto_id);

    try {
        // type canto utilisé pour choisir l’url de téléchargement
        const scheme = (payload.scheme || 'image').toLowerCase();
        console.log(`[Auto-Sync] Fichier détecté : ${nom_fichier} (Type: ${scheme})`);
        // domaine canto utilisé pour construire les appels api
        const cantoDomain = (process.env.CANTO_DOMAIN || "").replace('https://', '').replace('http://', '').replace(/\/$/, '');
        // jeton oauth utilisé pour appeler canto
        const cantoToken = await getCantoToken();
        console.log(`[DEBUG] Token généré (10 premiers char) : ${cantoToken.substring(0, 10)}...`);
        console.log(`[DEBUG] URL appelée : https://${cantoDomain}/api/v1/${scheme}/${canto_id}`);

        // données reçues pour detail response
        const detailResponse = await fetch(`https://${cantoDomain}/api/v1/${scheme}/${canto_id}`, {
            headers: {
                'Authorization': `Bearer ${cantoToken}`,
                'User-Agent': 'App Canto Publishing',
                'Accept': 'application/json'
            }
        });

        if (!detailResponse.ok) {
            // détail texte reçu lorsque canto refuse la requête
            const errorDetail = await detailResponse.text();
            console.error(`[DEBUG FATAL] Canto a refusé l'accès. Raison : ${errorDetail}`);
            throw new Error(`Erreur API Canto (${detailResponse.status}) pour le fichier ${nom_fichier} - Motif: ${errorDetail}`);
        }

        // métadonnées complètes de l’asset renvoyées par canto
        const assetData = await detailResponse.json();

        // adresse utilisée pour download url
        const download_url = (assetData.url && assetData.url.directUrlOriginal) ? assetData.url.directUrlOriginal : (assetData.url && assetData.url.download);
        if (!download_url) {
            console.log(`[Auto-Sync] Pas de lien direct pour ${nom_fichier}.`);
            return;
        }

        // identifiant du folder actuellement traité
        let folder_id = null;
        if (assetData.relatedAlbums && assetData.relatedAlbums.length > 0) {
            // nom du premier album associé à l’asset canto
            const albumName = assetData.relatedAlbums[0].name;
            // données de folders ou de classement renvoyées par la requête sql
            const folderRes = await pool.query("SELECT id FROM folders WHERE name = $1 LIMIT 1", [albumName]);
            if (folderRes.rows.length > 0) folder_id = folderRes.rows[0].id;
        }

        console.log(`[Auto-Sync] Aspiration de : ${nom_fichier} en cours...`);

        // données reçues pour file response
        const fileResponse = await fetch(download_url);
        if (!fileResponse.ok) throw new Error("Erreur téléchargement depuis Canto");
        // classe qui convertit le flux web en flux node
        const { Readable } = require('stream');
        // flux web converti en flux node pour azure
        const nodeStream = Readable.fromWeb(fileResponse.body);

        // extension du fichier actuellement traité
        const ext = nom_fichier.split('.').pop().toLowerCase();

        // types mime connus pour les fichiers canto
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

        // type mime choisi pour le blob importé
        const contentType = mimeTypes[ext] || fileResponse.headers.get('content-type') || 'application/octet-stream';

        // client azure qui agit sur le blob du fichier courant
        const blockBlobClient = containerClient.getBlockBlobClient(nom_fichier);
        await blockBlobClient.uploadStream(nodeStream, 4 * 1024 * 1024, 20, {
            blobHTTPHeaders: {
                blobContentType: contentType,
                blobContentDisposition: 'inline'
            }
        });
        // adresse utilisée pour azure url
        const azureUrl = blockBlobClient.url;

        // liste des tags associés au fichier
        let tags = [];
        if (assetData.smartTags) tags = tags.concat(assetData.smartTags);
        if (assetData.tag) tags = tags.concat(typeof assetData.tag === 'string' ? assetData.tag.split(',') : assetData.tag);

        // description associée au fichier traité
        const description = assetData.description || "";
        // copyright lu dans les métadonnées canto
        const copyright = assetData.copyright || (assetData.additional && assetData.additional['Copyright']) || "";
        // auteur lu dans les métadonnées canto
        const author = assetData.ownerName || assetData.uploadedBy || (assetData.additional && assetData.additional['Author']) || "Canto Sync";
        // coopérative lue dans les métadonnées canto
        const cooperative = assetData.additional && assetData.additional['Cooperative'] || "";
        // nombre calculé pour country
        const country = assetData.country || (assetData.additional && assetData.additional['Country']) || "";
        // nom du projet lu dans les métadonnées canto
        const project_name = assetData.additional && assetData.additional['Project Name'] || "";
        // région lue dans les métadonnées canto
        const region = assetData.additional && assetData.additional['Region'] || "";
        // vague lue dans les métadonnées canto
        const wave = assetData.additional && assetData.additional['Wave'] || "";
        // consentement du farmer lu dans les métadonnées canto
        const farmer_consent = assetData.additional && assetData.additional['Farmer Consent'] || "";

        // lit un champ complémentaire canto qui doit contenir une liste
        // retourne toujours un tableau pour simplifier la suite du traitement
        const extractArray = (field) => {
            if (!assetData.additional || !assetData.additional[field]) return [];
            // valeur du champ complémentaire canto en cours de lecture
            const val = assetData.additional[field];
            return Array.isArray(val) ? val : [val];
        };

        // objet qui regroupe les métadonnées pour metadata
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

        // valeur de date utilisée pour raw date
        let rawDate = assetData.time || new Date();
        // date d’ajout normalisée avant son enregistrement
        let date_ajout;
        try {
            if (typeof rawDate === 'string' && /^\d{8,17}$/.test(rawDate)) {
                // année extraite de la date
                const year = rawDate.slice(0, 4);
                // mois extrait de la date
                const month = rawDate.slice(4, 6);
                // jour extrait de la date
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

        if (typeof generateAndUploadThumbnail === 'function') {
            generateAndUploadThumbnail(nom_fichier, containerClient, pool);
        }

        console.log(`[Auto-Sync] Terminé ! Fichier ${nom_fichier} est en ligne avec ses métadonnées.`);

    } catch (error) {
        console.error('[Auto-Sync] Erreur fatale:', error.message);
    } finally {
        // libère l’asset canto de la liste des traitements après le délai
        setTimeout(() => {
            processingFiles.delete(canto_id);
        }, 10000);
    }
});

// affiche les statistiques et les logs filtrés
// réservé au rôle admin (pas basic_admin / moderator)
app.get('/stats', loginRequiredHtml, adminRequired, async (req, res) => {
    try {
        // événement choisi pour filtrer les statistiques
        const selectedEvent = typeof req.query.event === 'string' ? req.query.event.trim().slice(0, 100) : '';
        // utilisateur choisi pour filtrer les statistiques
        const selectedUser = typeof req.query.user === 'string' ? req.query.user.trim().slice(0, 100) : '';
        // numéro de la page demandée pour la pagination
        const requestedLogPage = Math.max(1, parseInt(req.query.log_page, 10) || 1);
        // nombre maximal de lignes affichées sur une page
        const logsPerPage = 100;
        // filtre utilisé pour log conditions
        const logConditions = [];
        // paramètres préparés pour exécuter la requête sans concaténer les valeurs
        const logFilterParams = [];

        if (selectedEvent) {
            logFilterParams.push(selectedEvent);
            logConditions.push(`event_name = $${logFilterParams.length}`);
        }
        if (selectedUser) {
            logFilterParams.push(selectedUser);
            logConditions.push(`username = $${logFilterParams.length}`);
        }

        // clause where construite pour filtrer les logs
        const logWhereClause = logConditions.length > 0
            ? `WHERE ${logConditions.join(' AND ')}`
            : '';

        // valeur statistique renvoyée par la requête sql
        const filteredLogsCountRes = await pool.query(
            `SELECT COUNT(*) FROM activity_logs ${logWhereClause};`,
            logFilterParams
        );
        // nombre calculé pour filtered logs count
        const filteredLogsCount = parseInt(filteredLogsCountRes.rows[0].count || 0, 10);
        // nombre calculé pour total log pages
        const totalLogPages = Math.max(1, Math.ceil(filteredLogsCount / logsPerPage));
        // numéro de la page demandée pour la pagination
        const currentLogPage = Math.min(requestedLogPage, totalLogPages);
        // nombre de lignes ignorées avant la page demandée
        const logOffset = (currentLogPage - 1) * logsPerPage;
        // paramètres préparés pour exécuter la requête sans concaténer les valeurs
        const logQueryParams = [...logFilterParams, logsPerPage, logOffset];

        // données statistiques renvoyées par la requête sql
        const recentLogsRes = await pool.query(`
            SELECT id, event_name, username, properties,
                   to_char(timestamp, 'DD-MM-YYYY HH24:MI:SS') as formatted_date
            FROM activity_logs
            ${logWhereClause}
            ORDER BY timestamp DESC
            LIMIT $${logQueryParams.length - 1} OFFSET $${logQueryParams.length};
        `, logQueryParams);

        // données statistiques renvoyées par la requête sql
        const allLogUsersRes = await pool.query(`
            SELECT username, COUNT(*) AS count
            FROM activity_logs
            WHERE username IS NOT NULL AND BTRIM(username) <> ''
            GROUP BY username
            ORDER BY LOWER(username) ASC;
        `);

        // données statistiques renvoyées par la requête sql
        const statsByEventRes = await pool.query(`
            SELECT event_name, COUNT(*) as count
            FROM activity_logs
            GROUP BY event_name
            ORDER BY count DESC;
        `);

        // données statistiques renvoyées par la requête sql
        const statsByUserRes = await pool.query(`
            SELECT username, COUNT(*) as count
            FROM activity_logs
            GROUP BY username
            ORDER BY count DESC LIMIT 10;
        `);

        // données statistiques renvoyées par la requête sql
        const timelineRes = await pool.query(`
            SELECT to_char(timestamp, 'YYYY-MM-DD') as day, COUNT(*) as count
            FROM activity_logs
            WHERE timestamp > NOW() - INTERVAL '7 days'
            GROUP BY day
            ORDER BY day ASC;
        `);

        // valeur statistique renvoyée par la requête sql
        const totalLogsRes = await pool.query("SELECT COUNT(*) FROM activity_logs;");
        const totalUploadsRes = await pool.query("SELECT COUNT(*) FROM activity_logs WHERE event_name ILIKE '%upload%' OR event_name ILIKE '%ajout%';");
        const totalDeletesRes = await pool.query("SELECT COUNT(*) FROM activity_logs WHERE event_name ILIKE '%delete%' OR event_name ILIKE '%suppr%';");
        const avgPageLoadRes = await pool.query("SELECT ROUND(AVG(CAST(properties->>'duration_ms' AS INTEGER))) as avg FROM activity_logs WHERE event_name = 'page_load';");
        const avgDownloadSpeedRes = await pool.query("SELECT ROUND(AVG(CAST(properties->>'speed_mbps' AS NUMERIC)), 2) as avg FROM activity_logs WHERE event_name = 'file_download';");
        // comptes utilisateurs renvoyés par la requête sql
        const activeUsersTodayRes = await pool.query("SELECT COUNT(DISTINCT username) as count FROM activity_logs WHERE timestamp > CURRENT_DATE;");
        // données statistiques renvoyées par la requête sql
        const pageLoadStatsRes = await pool.query("SELECT properties->>'path' as path, COUNT(*) as count, ROUND(AVG(CAST(properties->>'duration_ms' AS INTEGER))) as avg_duration FROM activity_logs WHERE event_name = 'page_load' GROUP BY path ORDER BY count DESC;");

        res.render('stats.html', {
            recentLogs: recentLogsRes.rows,
            statsByEvent: statsByEventRes.rows,
            statsByUser: statsByUserRes.rows,
            allLogUsers: allLogUsersRes.rows,
            selectedEvent: selectedEvent,
            selectedUser: selectedUser,
            filteredLogsCount: filteredLogsCount,
            currentLogPage: currentLogPage,
            totalLogPages: totalLogPages,
            hasPreviousLogPage: currentLogPage > 1,
            hasNextLogPage: currentLogPage < totalLogPages,
            previousLogPage: Math.max(1, currentLogPage - 1),
            nextLogPage: Math.min(totalLogPages, currentLogPage + 1),
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



// démarre le serveur express sur le port fourni par l’environnement
 const server = app.listen(PORT, () => {
    console.log(`serv Node.js démarré sur http://localhost:${PORT}`);
});

server.keepAliveTimeout = 120000; 
server.headersTimeout = 120000;