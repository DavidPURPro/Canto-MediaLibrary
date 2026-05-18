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
    max: 30, 
    idleTimeoutMillis: 30000, 
});
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

            await blockBlobClient.uploadStream(file.stream, bufferSize, maxBuffers, {
                blobHTTPHeaders: { 
                    blobContentType: file.mimetype,
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
    const forbidden_extensions = [".heic", ".thm"];
    
    if (forbidden_extensions.includes(ext)) {
        return cb(new Error(`Extension '${ext}' non autorisée`));
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
//app.set('trust proxy', 1); // a mettre en prod avec secure : true
app.use(session({
    secret: process.env.SECRET_KEY || 'super_secret_key_de_secours',
    resave: false,
    saveUninitialized: false,
    name: 'portal_session',
    cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 30 * 60 * 1000 }
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
                } else {
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

app.use('/static', express.static(path.join(__dirname, 'static')));


app.get('/', loginRequiredHtml, (req, res) => {
    res.redirect('/index');
});

app.get('/', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const sort = req.query.sort || 'date_desc';
    const filter = req.query.filter || 'all';
    const limit = 12;
    const offset = (page - 1) * limit;
    const ext = {
        images: ["'%.png'", "'%.jpg'", "'%.jpeg'", "'%.gif'", "'%.bmp'", "'%.svg'", "'%.webp'"],
        videos: ["'%.mp4'", "'%.mov'", "'%.avi'", "'%.wmv'", "'%.flv'", "'%.mkv'", "'%.webm'"],
        audio: ["'%.mp3'", "'%.wav'", "'%.aac'", "'%.flac'", "'%.ogg'", "'%.m4a'"],
        documents: ["'%.pdf'", "'%.doc'", "'%.docx'", "'%.xls'", "'%.xlsx'", "'%.txt'", "'%.rtf'", "'%.odt'"],
        presentations: ["'%.ppt'", "'%.pptx'", "'%.key'", "'%.odp'"]
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
            baseQuery += ` AND LOWER(d.nom_fichier) NOT LIKE ANY(ARRAY[${allKnownExts.join(',')}])`;
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
            is_admin: req.session.is_admin
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
        is_admin: req.session.is_admin
    });
});

async function isUserAdmin(accessToken) {
    const adminGroupId = process.env.ADMIN_GROUP_ID;
    if (!adminGroupId) return false;
    
    try {
        const client = Client.init({ authProvider: (done) => done(null, accessToken) });
        const response = await client.api(`/me/memberOf?$filter=id eq '${adminGroupId}'`).get();
        return response.value && response.value.length > 0;
    } catch (e) {
        if (e.message && e.message.includes("Insufficient privileges"))
        return false;
      console.error("Erreur Graph API (Admin Check):", e.message);
      return false;
    }
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
            return res.status(403).send(`Accès refusé : seul le domaine @${allowedDomain} est autorisé.`);
        }

        const isAdmin = await isUserAdmin(response.accessToken);
        req.session.access_token = response.accessToken;
        req.session.user_email = email;
        req.session.username = email.split('@')[0];
        req.session.is_admin = isAdmin;
        if (insightsClient) {
            insightsClient.trackEvent({
                name: "login_reussi",
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
            SELECT COUNT(DISTINCT filename) as count FROM (
                SELECT filename FROM portal_files WHERE portal_id = $1
                UNION
                SELECT nom_fichier FROM documents WHERE folder_id IN (
                    SELECT folder_id FROM portal_folders WHERE portal_id = $1
                )
            ) as combined_files;
        `, [portal_id]);

        const sizeResult = await pool.query(`
            SELECT SUM(size_bytes) as total_bytes FROM portal_files WHERE filename IN (
                SELECT filename FROM portal_files WHERE portal_id = $1
                UNION
                SELECT nom_fichier FROM documents WHERE folder_id IN (
                    SELECT folder_id FROM portal_folders WHERE portal_id = $1
                )
            );
        `, [portal_id]);
        const file_count = parseInt(countResult.rows[0].count || 0, 10);
        const total_bytes = parseInt(sizeResult.rows[0].total_bytes || 0, 10);
        const total_size = formatBytes(total_bytes);
        await pool.query(`
            UPDATE portals 
            SET files = $1, size = $2, last_sync = CURRENT_DATE 
            WHERE id = $3;
        `, [file_count, total_size, portal_id]);
        return { file_count, total_size };
    } catch (e) {
        console.error("Erreur updatePortalStats:", e);
    }
}

// routes API (folders et recherche)
app.get('/get_folders', loginRequiredJson, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name, parent_id FROM folders ORDER BY name;");
        const folders = result.rows.map(f => ({
            id: f.id,
            name: f.name,
            parent_id: f.parent_id
        }));
        res.json({ folders });
    } catch (error) {
        console.error("Erreur get_folders:", error);
        res.status(500).json({ error: "Erreur serveur" });
    }
});

app.get('/search_file', loginRequiredJson, async (req, res) => {
    try {
        const filename = req.query.filename;
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
        const ext = {
            images: ["'%.png'", "'%.jpg'", "'%.jpeg'", "'%.gif'", "'%.bmp'", "'%.svg'", "'%.webp'"],
            videos: ["'%.mp4'", "'%.mov'", "'%.avi'", "'%.wmv'", "'%.flv'", "'%.mkv'", "'%.webm'"],
            audio: ["'%.mp3'", "'%.wav'", "'%.aac'", "'%.flac'", "'%.ogg'", "'%.m4a'"],
            documents: ["'%.pdf'", "'%.doc'", "'%.docx'", "'%.xls'", "'%.xlsx'", "'%.txt'", "'%.rtf'", "'%.odt'"],
            presentations: ["'%.ppt'", "'%.pptx'", "'%.key'", "'%.odp'"]
        };
        const allKnownExts = [...ext.images, ...ext.videos, ...ext.audio, ...ext.documents, ...ext.presentations];
        let query = `
            SELECT nom_fichier, lien_telechargement, description, tags, is_exclusive, date_ajout, date_event, folder_id,
                   COUNT(*) OVER() as total_count
            FROM documents
            WHERE 1=1
        `;
        const params = [];
        if (filename) {
            const searchWords = filename.split(/\s+/).filter(w => w.length > 0);
            for (const word of searchWords) {
                const searchTerm = `%${word}%`;
                params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
                const pLen = params.length;
                query += ` AND (nom_fichier ILIKE $${pLen - 4} OR description ILIKE $${pLen - 3} OR tags::text ILIKE $${pLen - 2} OR section ILIKE $${pLen - 1} OR category ILIKE $${pLen})`;
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
            query += ` AND LOWER(nom_fichier) NOT LIKE ANY(ARRAY[${allKnownExts.join(',')}])`;
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
                folder_id: row.folder_id
            };
        });

        res.json({
            files: files,
            total: total_count,
            page: page,
            total_pages: Math.ceil(total_count / per_page)
        });

    } catch (error) {
        console.error("Erreur search_file:", error.message);
        res.json({ files: [], total: 0, page: 1, total_pages: 0 });
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

app.get('/upload', loginRequiredHtml, adminRequired, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name, parent_id FROM folders ORDER BY name;");
        const folders = buildFolderHierarchy(result.rows);
        const portalsRes = await pool.query("SELECT id, name FROM portals ORDER BY name ASC;");
        res.render('upload.html', { 
            folders: folders, 
            portals: portalsRes.rows 
        });
    } catch (error) {
        console.error("Erreur chargement page upload:", error);
        res.status(500).send("Erreur serveur");
    }
});

app.post('/upload', loginRequiredJson, adminRequired, (req, res, next) => {
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
            return res.status(500).json({ status: "error", message: "Erreur lors du transfert des fichiers." });
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

            // enregistre dans la table globale (documents)
            await pool.query(`
                INSERT INTO documents (
                    nom_fichier, lien_telechargement, description, tags, 
                    date_ajout, date_event, folder_id, section, category
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
            `, [filename, blob_url, description, JSON.stringify(tags), currentDate, date_event, folder_id, section, category]);

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
                    name: "Fichier_upload",
                    properties: {
                        fichier: filename,
                        utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
                    }
                });
            }
        }
        res.json({ status: "success", urls: uploaded_urls });

    } catch (error) {
        console.error("Erreur lors de l'enregistrement en BDD:", error);
        res.status(500).json({ status: "error", message: "Erreur lors de l'enregistrement en BDD." });
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
            SELECT description, tags, date_ajout, is_exclusive, date_event, folder_id, section, category
            FROM documents
            WHERE nom_fichier = $1;
        `, [filename]);

        if (docResult.rows.length === 0) {
            return res.status(404).json({ error: "File not found" });
        }

        const doc = docResult.rows[0];
        const portalResult = await pool.query(`
            SELECT portal_id FROM portal_files WHERE filename = $1 LIMIT 1;
        `, [filename]);
        
        const portal_id = portalResult.rows.length > 0 ? portalResult.rows[0].portal_id : null;
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
            section : doc.section || "",
            category : doc.category || ""
        });

    } catch (error) {
        console.error("Erreur dans file_details:", error);
        res.status(500).json({ error: "Erreur serveur interne" });
    }
});

// routes gestion folders
app.post('/create_folder', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const name = req.body.name;
        const parent_id = (req.body.parent_id && req.body.parent_id !== "none") ? req.body.parent_id : null;

        if (!name) {
            return res.status(400).json({ status: "error", message: "Nom du dossier requis" });
        }

        const result = await pool.query(
            "INSERT INTO folders (name, parent_id) VALUES ($1, $2) RETURNING id;",
            [name, parent_id]
        );
        const folder_id = result.rows[0].id;
        if (insightsClient) {
            insightsClient.trackEvent({
                name: "Folder_Cree",
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
app.post('/delete_folder', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const folder_id = req.body.folder_id;

        if (!folder_id) {
            return res.status(400).json({ status: "error", message: "ID du dossier requis" });
        }

        const delRes = await pool.query("DELETE FROM folders WHERE id = $1 RETURNING name;", [folder_id]);
        const folderName = delRes.rows.length > 0 ? delRes.rows[0].name : "Dossier Inconnu";
        insightsClient.trackEvent({
            name: "Folder_Supprime",
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
app.post('/rename_folder', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const { folder_id, new_name } = req.body;
        if (!folder_id || !new_name || new_name.trim() === "") {
            return res.status(400).json({ status: "error", message: "ID et nouveau nom valides requis" });
        }
        const cleanName = new_name.trim();
        const selectRes = await pool.query("SELECT name FROM folders WHERE id = $1;", [folder_id]);
        if (selectRes.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "dossier introuvable" });
        }
        const ancienNom = selectRes.rows[0].name;
        await pool.query("UPDATE folders SET name = $1 WHERE id = $2;", [cleanName, folder_id]);
        if (typeof insightsClient !== 'undefined' && insightsClient) {
            insightsClient.trackEvent({
                name: "Folder_Renomme",
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
        res.status(500).json({ status: "error", message: "Erreur lors du renommage en BDD" });
    }
});

app.post('/update_file_folder', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const filename = req.body.filename;
        let folder_id = req.body.folder_id;

        if (!folder_id || folder_id === "none") {
            folder_id = null;
        }

        if (!filename) {
            return res.status(400).json({ status: "error", message: "Nom de fichier requis" });
        }

        await pool.query(
            "UPDATE documents SET folder_id = $1 WHERE nom_fichier = $2;",
            [folder_id, filename]
        );
        insightsClient.trackEvent({
            name: "update_file_folder",
            properties: {
                fichier: filename,
                utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
            }
        });
        res.json({ status: "success" });
    } catch (error) {
        console.error("Erreur update_file_folder:", error);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// ASSIGNATION EN MASSE DE FICHIERS À UN DOSSIER
app.post('/bulk_update_file_folder', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const { folder_id, filenames } = req.body; 
        const filesArray = JSON.parse(filenames || "[]");
        const targetFolder = (folder_id && folder_id !== "none" && folder_id !== "") ? parseInt(folder_id, 10) : null;
        if (filesArray.length === 0) {
            return res.status(400).json({ status: "error", message: "Aucun fichier sélectionné" });
        }
        await pool.query(
            "UPDATE documents SET folder_id = $1 WHERE nom_fichier = ANY($2);",
            [targetFolder, filesArray]
        );
        res.json({ 
            status: "success", 
            message: `${filesArray.length} fichiers ont été déplacés avec succès.` 
        });
    } catch (error) {
        console.error("Erreur bulk_update_file_folder:", error);
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
app.post('/remove_file_from_folder', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const filename = req.body.filename;
        
        if (!filename) {
            return res.status(400).json({ status: "error", message: "Nom de fichier requis" });
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
            return res.status(400).json({ status: "error", message: "Nom de fichier requis" });
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

app.post('/remove_file_folder', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
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
            res.json({ status: "success", message: "Fichier retiré du dossier" });
        } 
        else {
            res.status(404).json({ status: "error", message: "Fichier non trouvé en base" });
        }
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

// réassigner fichier a un folder
app.post('/assign_file_folder', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
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
            res.json({ status: "success", message: "Fichier réassigné avec succès",
    folder_id: folder_id});
        } 
        else {
            res.status(404).json({ status: "error", message: "Fichier non trouvé" });
        }
    } catch (error) {
        console.error("Erreur SQL lors de l'assignation:", error);
        res.status(500).json({ status: "error", message: "Erreur interne du serveur" });
    }
});

// réassigner fichier a un portail
app.post('/assign_file_portal', loginRequiredJson, upload.none(), async (req, res) => {
    const { filename, portal_id } = req.body;

    try {
        const docResult = await pool.query("SELECT id FROM documents WHERE nom_fichier = $1", [filename]);
        
        if (docResult.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Fichier non trouvé" });
        }
        const documentId = docResult.rows[0].id;
        await pool.query("DELETE FROM document_portals WHERE document_id = $1", [documentId]);
        await pool.query(
            "INSERT INTO document_portals (document_id, portal_id) VALUES ($1, $2)",
            [documentId, portal_id]
        );
        insightsClient.trackEvent({
            name: "assign_file_portal",
            properties: {
                fichier: filename,
                utilisateur: req.session.user_email || req.session.portal_user_email || "Visiteur"
            }
        });
        res.json({ status: "success", message: "Portail mis à jour" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error" });
    }
});

app.get('/get_document_info/:id', loginRequiredJson, async (req, res) => {
    const docId = req.params.id;
    try {
        const query = `
            SELECT 
                d.*, 
                f.name as folder_name,
                (SELECT STRING_AGG(p.name, ', ') 
                 FROM portals p 
                 JOIN document_portals dp ON p.id = dp.portal_id 
                 WHERE dp.document_id = d.id) as portals_list
            FROM documents d
            LEFT JOIN folders f ON d.folder_id = f.id
            WHERE d.id = $1
        `;
        const result = await pool.query(query, [docId]);
        
        if (result.rows.length > 0) {
            res.json(result.rows[0]);
        } 
        else {
            res.status(404).json({ error: "Document non trouvé" });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// routes suppr et maj fichiers
// afficher la page
app.get('/delete', loginRequiredHtml, adminRequired, (req, res) => {
    res.render('delete.html');
});

// suppr définitivement un fichier (Azure + bdd)
app.post('/delete', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const filename = req.body.filename;
        const confirmation = req.body.confirmation === "on";
        if (!confirmation) {
            return res.status(400).json({ status: "error", message: "Confirmation requise" });
        }
        if (!filename) {
            return res.status(400).json({ status: "error", message: "Nom de fichier requis" });
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

// maj le statut exclusif
app.post('/update_exclusive', loginRequiredJson, adminRequired, upload.none(), async (req, res) => {
    try {
        const filename = req.body.filename;
        const is_exclusive = req.body.is_exclusive === 'true';

        if (!filename) {
            return res.status(400).json({ status: "error", message: "Nom de fichier requis" });
        }

        const result = await pool.query(
            "UPDATE documents SET is_exclusive = $1 WHERE nom_fichier = $2 RETURNING is_exclusive;",
            [is_exclusive, filename]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ status: "error", message: "Fichier non trouvé" });
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
                SELECT COUNT(DISTINCT filename) as count FROM (
                    SELECT filename FROM portal_files WHERE portal_id = $1
                    UNION
                    SELECT nom_fichier FROM documents WHERE folder_id IN (
                        SELECT folder_id FROM portal_folders WHERE portal_id = $1
                    )
                ) as combined_files;
            `, [row.id]);
            const sizeResult = await pool.query(`
                SELECT SUM(size_bytes) as sum FROM portal_files WHERE filename IN (
                    SELECT filename FROM portal_files WHERE portal_id = $1
                    UNION
                    SELECT nom_fichier FROM documents WHERE folder_id IN (
                        SELECT folder_id FROM portal_folders WHERE portal_id = $1
                    )
                );
            `, [row.id]);
            const file_count = parseInt(countResult.rows[0].count || 0, 10);
            const total_bytes = parseInt(sizeResult.rows[0].sum || 0, 10);
            portals_list.push({
                id: row.id,
                name: row.name,
                url: row.url,
                access: row.access,
                files: file_count,
                size: formatBytes(total_bytes),
                creation_date: row.creation_date ? new Date(row.creation_date).toLocaleDateString('fr-FR').replace(/\//g, '-') : "",
                last_sync: row.last_sync ? new Date(row.last_sync).toLocaleDateString('fr-FR').replace(/\//g, '-') : "",
                linked_folder_id: row.linked_folder_id
            });
        }

        res.render('portals.html', { portals: portals_list, is_admin: req.session.is_admin });
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

        // ----------------------------------------------------
        // NOUVEAU : Formatage ultra-sécurisé de la date 
        // (Force le format JJ-MM-AAAA quoi qu'il arrive)
        // ----------------------------------------------------
        const formatSafeDate = (dObj) => {
            if (!dObj) return "";
            const d = new Date(dObj);
            if (isNaN(d.getTime())) return "";
            return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth()+1).padStart(2, '0')}-${d.getFullYear()}`;
        };

        const linkedFoldersRes = await pool.query(`
            SELECT f.id, f.name FROM folders f
            JOIN portal_folders pf ON f.id = pf.folder_id
            WHERE pf.portal_id = $1 ORDER BY f.name;
        `, [real_portal_id]);

        const folderSections = [];
        const processedFilenames = new Set();

        for (let folder of linkedFoldersRes.rows) {
            const filesRes = await pool.query(`
                SELECT d.id as doc_id, d.nom_fichier as filename, d.lien_telechargement as file_url, 
                       d.description, d.date_ajout, d.date_event, d.tags, d.is_exclusive, f.name as folder_name
                FROM documents d
                LEFT JOIN folders f ON d.folder_id = f.id
                WHERE d.folder_id = $1 ORDER BY d.date_ajout DESC;
            `, [folder.id]);

            let heroUrl = null;
            const firstImage = filesRes.rows.find(f => 
                ['.png', '.jpg', '.jpeg', '.gif', '.webp'].some(ext => f.filename.toLowerCase().endsWith(ext))
            );
            if (firstImage) heroUrl = firstImage.file_url;

            const sectionFiles = filesRes.rows.map(f => {
                processedFilenames.add(f.filename);
                let parsedTags = [];
                try { parsedTags = JSON.parse(f.tags || "[]"); } catch(e){}
                return {
                    filename: f.filename, description: f.description || "No description",
                    file_url: f.file_url, file_type: ['.mp4','.mov'].some(ext => f.filename.toLowerCase().endsWith(ext)) ? "Video" : "Image",
                    tags: parsedTags, is_exclusive: Boolean(f.is_exclusive), folder_name: f.folder_name,
                    upload_date: formatSafeDate(f.date_ajout),  // Utilisation de la date sécurisée
                    event_date: formatSafeDate(f.date_event),   // Utilisation de la date sécurisée
                    size_bytes: 0,
                    size: "Unknown size" // Protection si la taille est manquante
                };
            });

            folderSections.push({
                folder_id: folder.id,
                folder_name: folder.name,
                hero_image_url: heroUrl,
                files: sectionFiles
            });
        }
        
        const manualFilesRes = await pool.query(`
            SELECT pf.*, d.tags, d.is_exclusive, d.date_ajout, d.date_event FROM portal_files pf 
            LEFT JOIN documents d ON pf.filename = d.nom_fichier
            WHERE pf.portal_id = $1;
        `, [real_portal_id]);

        const manualFiles = [];
        let total_bytes = 0;
        manualFilesRes.rows.forEach(f => {
            total_bytes += parseInt(f.size_bytes || 0, 10);
            if (!processedFilenames.has(f.filename)) {
                let parsedTags = [];
                try { parsedTags = JSON.parse(f.tags || "[]"); } catch(e){}
                manualFiles.push({
                    filename: f.filename, description: f.description, file_url: f.file_url,
                    file_type: f.file_type, tags: parsedTags, is_exclusive: Boolean(f.is_exclusive), folder_name: "General Assets",
                    upload_date: formatSafeDate(f.date_ajout) || formatSafeDate(f.upload_date), // Sécurité maximale
                    event_date: formatSafeDate(f.date_event),
                    size_bytes: f.size_bytes,
                    size: f.size
                });
            }
        });

        if (manualFiles.length > 0) {
            folderSections.push({
                folder_id: 'manual', folder_name: 'General Assets', hero_image_url: null, files: manualFiles
            });
        }

        const portal_data = {
            id: portalRow.id, slug: slug, name: portalRow.name, access: portalRow.access,
            files_count: processedFilenames.size + manualFiles.length, size: formatBytes(total_bytes),
            creation_date: portalRow.creation_date ? new Date(portalRow.creation_date).toLocaleDateString('fr-FR').replace(/\//g, '-') : "",
            last_sync: portalRow.last_sync ? new Date(portalRow.last_sync).toLocaleDateString('fr-FR').replace(/\//g, '-') : ""
        };

        res.render('portal_page.html', { 
          portal: portal_data, folderSections: folderSections, is_admin: isAdmin,
          user_email: req.session.user_email || req.session.portal_user_email,
          username: req.session.username || "User", is_global_auth: isGlobalAuth
        });
    } catch (error) {
        console.error(error); res.status(500).send("Erreur serveur");
    }
});

// routes gestion portails
app.post('/add_portal', loginRequiredJson, async (req, res) => {
    try {
        const { name, access = 'Public', linked_folder_ids } = req.body;
        if (!name) return res.status(400).json({ status: "error", message: "Name is required" });
        const existRes = await pool.query("SELECT id FROM portals WHERE name = $1;", [name]);
        if (existRes.rows.length > 0) return res.status(400).json({ status: "error", message: "Portal with this name already exists" });

        const insertRes = await pool.query(`
            INSERT INTO portals (name, url, access, creation_date, last_sync)
            VALUES ($1, '', $2, CURRENT_DATE, CURRENT_DATE) RETURNING id;
        `, [name, access]);
        
        const portal_id = insertRes.rows[0].id;        
        const chosenFolders = JSON.parse(linked_folder_ids || "[]");
        for (let folder_id of chosenFolders) {
            await pool.query("INSERT INTO portal_folders (portal_id, folder_id) VALUES ($1, $2);", [portal_id, folder_id]);
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
        const { filename, portal_id } = req.body;
        if (!filename) return res.status(400).json({ status: "error", message: "Nom de fichier requis" });

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
            name: "Fichier_Supprime_from_portal",
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
                    name: "login_portail_reussi",
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
                name: "Admin_Ajout_Utilisateur",
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
                name: "Admin_Suppression_Utilisateur",
                properties: { admin: req.session.user_email }
            });
        }
        res.json({ status: "success", message: "User access has been revoked" });
    } catch (error) {
        console.error("Erreur delete_user:", error);
        res.status(500).json({ status: "error", message: "Server error during deletion." });
    }
});

// ==========================================
// ROUTE DE MAINTENANCE : Réparer les fichiers Azure (Forcer l'affichage)
// ==========================================
// REGELER AFFICHAGE COPIE LIEN
/*app.get('/admin/fix_azure_headers', loginRequiredHtml, adminRequired, async (req, res) => {
    try {
        // On récupère tous les fichiers de la base
        const result = await pool.query("SELECT nom_fichier FROM documents");
        let updatedCount = 0;
        let missingCount = 0;

        for (let row of result.rows) {
            const filename = row.nom_fichier;
            const ext = require('path').extname(filename).toLowerCase();

            // On déduit le bon type MIME selon l'extension
            let mimeType = 'application/octet-stream';
            if (['.jpg', '.jpeg'].includes(ext)) mimeType = 'image/jpeg';
            else if (ext === '.png') mimeType = 'image/png';
            else if (ext === '.gif') mimeType = 'image/gif';
            else if (ext === '.webp') mimeType = 'image/webp';
            else if (ext === '.pdf') mimeType = 'application/pdf';
            else if (ext === '.mp4') mimeType = 'video/mp4';

            const blockBlobClient = containerClient.getBlockBlobClient(filename);

            try {
                // On essaie de forcer Azure à mettre à jour les en-têtes
                await blockBlobClient.setHTTPHeaders({
                    blobContentType: mimeType,
                    blobContentDisposition: 'inline'
                });
                updatedCount++;
            } catch (azureErr) {
                // Si le fichier n'existe pas sur Azure, on l'ignore et on passe au suivant
                if (azureErr.statusCode === 404) {
                    console.warn(`⚠️ Fichier introuvable sur Azure (ignoré) : ${filename}`);
                    missingCount++;
                } else {
                    console.error(`❌ Erreur inattendue pour ${filename}:`, azureErr.message);
                }
            }
        }

        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h1 style="color: #166534;">✅ Opération terminée !</h1>
                <p><strong>${updatedCount} fichiers</strong> ont été mis à jour avec succès sur Azure.</p>
                <p style="color: #ea580c;"><strong>${missingCount} fichiers fantômes</strong> ont été ignorés (présents en BDD mais absents d'Azure).</p>
                <p>Les fichiers réparés s'afficheront désormais directement dans le navigateur !</p>
                <a href="/" style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #0078d4; color: white; text-decoration: none; border-radius: 6px;">Retour à la galerie</a>
            </div>
        `);
    } catch (error) {
        console.error("Erreur fix_azure_headers:", error);
        res.status(500).send("Erreur critique lors de la mise à jour des fichiers. Regarde la console.");
    }
});
*/

// ROUTE PROXY POUR LE TÉLÉCHARGEMENT ZIP 
const https = require('https'); 
app.get('/proxy_download', loginRequiredJson, (req, res) => {
    const fileUrl = req.query.url;
    if (!fileUrl) return res.status(400).send("URL missing");
    https.get(fileUrl, (response) => {
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');        
        response.pipe(res);
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
            return res.status(400).json({ status: "error", message: "Paramètres manquants" });
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
        const { portal_id, folder_ids } = req.body;
        const chosenFolders = JSON.parse(folder_ids || "[]");
        await pool.query("DELETE FROM portal_folders WHERE portal_id = $1;", [portal_id]);
        if (chosenFolders.length > 0) {
            for (let folder_id of chosenFolders) {
                await pool.query("INSERT INTO portal_folders (portal_id, folder_id) VALUES ($1, $2);", [portal_id, folder_id]);
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
        const result = await pool.query("SELECT folder_id FROM portal_folders WHERE portal_id = $1;", [req.params.portal_id]);
        const folderIds = result.rows.map(r => r.folder_id);
        res.json({ status: "success", folder_ids: folderIds });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`serv Node.js démarré sur http://localhost:${PORT}`);
});