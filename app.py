from email.message import EmailMessage

from flask import Flask, jsonify, render_template, send_file, request, redirect, url_for, session, flash
import psycopg2
import requests
from io import BytesIO
from azure.storage.blob import BlobServiceClient
import os
import json
from datetime import datetime, timedelta
from werkzeug.utils import secure_filename
from dotenv import load_dotenv
import msal
from functools import wraps
import re
from unidecode import unidecode
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from werkzeug.security import generate_password_hash, check_password_hash
import secrets

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv('SECRET_KEY')

app.config.update(
    SESSION_COOKIE_SECURE=False,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    PERMANENT_SESSION_LIFETIME=timedelta(minutes=30),
    SESSION_COOKIE_NAME='portal_session'
)

# config bdd
DB_CONFIG = {
    'host': os.getenv("POSTGRES_HOST"),
    'database': os.getenv("POSTGRES_DB"),
    'user': os.getenv("POSTGRES_USER"),
    'password': os.getenv("POSTGRES_PASSWORD"),
    'port': os.getenv("POSTGRES_PORT", "5432"),
}

# config Azure blob storage
AZURE_STORAGE_CONNECTION_STRING = os.getenv('AZURE_STORAGE_CONNECTION_STRING')
CONTAINER_NAME = os.getenv("AZURE_STORAGE_CONTAINER")
blob_service_client = BlobServiceClient.from_connection_string(AZURE_STORAGE_CONNECTION_STRING)

# config Azure AD MSAL
CLIENT_ID = os.getenv("AZURE_AD_CLIENT_ID")
TENANT_ID = os.getenv("AZURE_AD_TENANT_ID")
CLIENT_SECRET = os.getenv("AZURE_AD_CLIENT_SECRET")
ALLOWED_DOMAIN = os.getenv("ALLOWED_DOMAIN", "pur.co").lower()
AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
REDIRECT_URI = os.getenv("REDIRECT_URI", "http://localhost:5000/getAToken")
SCOPES = ["User.Read", "GroupMember.Read.All"]

#config email
SMTP_SERVER = os.getenv('SMTP_SERVER')
SMTP_PORT = int(os.getenv('SMTP_PORT', '587'))
SMTP_USERNAME = os.getenv('SMTP_USERNAME')
SMTP_PASSWORD = os.getenv('SMTP_PASSWORD')
ADMIN_EMAIL = os.getenv('ADMIN_EMAIL', 'david.guney@pur.co')

# init MSAL
"""
def _build_msal_app():
    return msal.PublicClientApplication(
        CLIENT_ID,
        authority=AUTHORITY,
    )
"""

def _build_msal_app(cache=None, authority=None):
    client_id = os.getenv('AZURE_AD_CLIENT_ID')
    tenant_id = os.getenv('AZURE_AD_TENANT_ID')
    
    # application publique on ne doit PAS utiliser client_secret
    return msal.PublicClientApplication(
        client_id=client_id,
        authority=authority or f"https://login.microsoftonline.com/{tenant_id}",
        token_cache=cache
    )

def generate_slug(name, portal_id):
    slug = unidecode(name).lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    slug = slug.strip('-')
    return f"{slug}-{portal_id}"

# helpers
def get_db_connection():
    return psycopg2.connect(**DB_CONFIG)

def build_folder_hierarchy(folders):
    folder_map = {f[0]: {"id": f[0], "name": f[1], "parent_id": f[2], "children": []} for f in folders}
    hierarchy = []
    for folder in folder_map.values():
        if folder["parent_id"] is None:
            hierarchy.append(folder)
        else:
            parent = folder_map.get(folder["parent_id"])
            if parent:
                parent["children"].append(folder)
    return hierarchy

def parse_tags(tags):
    if not tags:
        return []
    
    if isinstance(tags, str):
        if tags.startswith('{') and tags.endswith('}'):
            tags_content = tags[1:-1]
            return [tag.strip() for tag in tags_content.split(',') if tag.strip()]
        elif tags.startswith(('["', "['")):
            try:
                return json.loads(tags)
            except json.JSONDecodeError:
                pass
    
    return tags if isinstance(tags, list) else []

"""
def is_admin():
    admin_emails = [email.strip().lower() for email in os.getenv("ADMIN_EMAILS", "").split(",") if email.strip()]
    print(f"Admin emails: {admin_emails}")  # debug
    print(f"Current user email: {session.get('user_email', '').lower()}")
    return session.get('user_email', '').lower() in admin_emails
"""

def is_admin():
    admin_group_id = os.getenv("ADMIN_GROUP_ID")
    if not admin_group_id:
        return False
    
    user_email = session.get('user_email', '').lower()
    if not user_email:
        return False
    
    if 'access_token' in session:
        access_token = session['access_token']
        headers = {'Authorization': f'Bearer {access_token}'}
        
        try:
            check_url = f"https://graph.microsoft.com/v1.0/me/memberOf?$filter=id eq '{admin_group_id}'"
            response = requests.get(check_url, headers=headers)
            
            if response.status_code == 200:
                groups = response.json().get('value', [])
                return len(groups) > 0
            
        except Exception as e:
            print(f"Erreur de vérification de groupe: {str(e)}")
    
    return False

# décorateurs "login requis"
def login_required_html(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if request.path.startswith('/portal/'):
            portal_id = kwargs.get('portal_id')
            if 'portal_user_email' not in session:
                if portal_id:
                    return redirect(url_for('portal_login', portal_id=portal_id))
                else:
                    return redirect(url_for('portals'))
            return f(*args, **kwargs)
        elif 'user_email' not in session:
            session['next'] = request.url
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return wrapper

def login_required_json(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if 'user_email' not in session:
            return jsonify({"error": "Unauthorized"}), 401
        return f(*args, **kwargs)
    return wrapper

def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not is_admin():
            return render_template("403.html"), 403
        return f(*args, **kwargs)
    return wrapper

# routes authentification
@app.route('/')
def root():
    return redirect(url_for('login'))

@app.route('/login')
def login():
    if 'user_email' in session:
        return redirect(url_for('index'))
    if request.args.get('next'):
        session['next'] = request.args.get('next')
    elif request.referrer and 'portals/' in request.referrer:
        session['next'] = request.referrer
    elif 'next' not in session:  
        session['next'] = url_for('index')
    
    return render_template('login.html')

@app.route('/start_auth')
def start_auth():
    session['next'] = request.args.get('next', url_for('index'))
    msal_app = _build_msal_app()
    flow = msal_app.initiate_auth_code_flow(SCOPES, redirect_uri=REDIRECT_URI)
    session['flow'] = flow
    return redirect(flow['auth_uri'])

@app.route('/getAToken')
def authorized():
    if 'flow' not in session:
        flash('Session expired, please try again', 'warning')
        return redirect(url_for('login'))

    msal_app = _build_msal_app()
    try:
        result = msal_app.acquire_token_by_auth_code_flow(session['flow'], request.args)
    except ValueError:
        flash('OAuth security error', 'danger')
        return redirect(url_for('login'))
    finally:
        session.pop('flow', None)

    if 'error' in result:
        flash(f"Connection error: {result.get('error_description')}", 'danger')
        return redirect(url_for('login'))

    claims = result.get('id_token_claims', {})
    email = (claims.get('preferred_username') or claims.get('upn') or claims.get('email') or '').lower()

    if not email or not email.endswith(f"@{ALLOWED_DOMAIN}"):
        session.clear()
        return f"Access denied: only the domain @{ALLOWED_DOMAIN} is allowed.", 403

    next_url = session.pop('next', url_for('index'))
    
    if '/portals/' in next_url :
        slug_match = re.search(r'/portals/([^/?]+)', next_url)
        if slug_match:
            slug = slug_match.group(1)
            
            conn = get_db_connection()
            cur = conn.cursor()
            cur.execute("SELECT id, access FROM portals WHERE slug = %s;", (slug,))
            portal_result = cur.fetchone()
            cur.close()
            conn.close()
            
            if portal_result:
                portal_id, portal_access = portal_result
                
                session['portal_only'] = True
                session['portal_user_email'] = email
                session['portal_access'] = portal_id
                
                if portal_access.lower() == 'public':
                    return redirect(url_for('portal_page', portal_id=portal_id))
                else:
                    return redirect(url_for('portal_login', portal_id=portal_id))
    
    if 'access_token' in result:
        session['access_token'] = result['access_token']
    
    session['user_email'] = email
    session['username'] = email.split('@')[0]
    session['is_admin'] = is_admin()

    flash('Connection successful', 'success')
    return redirect(next_url)

@app.route('/logout')
def logout():
    portal_only = session.get('portal_only')
    portal_user_email = session.get('portal_user_email')
    portal_access = session.get('portal_access')
    session.clear()
    if portal_only:
        session['portal_only'] = portal_only
        session['portal_user_email'] = portal_user_email
        session['portal_access'] = portal_access
    
    post_logout = url_for('login', _external=True)
    aad_logout = f"{AUTHORITY}/oauth2/v2.0/logout?post_logout_redirect_uri={post_logout}"
    return redirect(aad_logout)

# -----------------------
# Routes principales
# -----------------------
@app.route('/index')
@login_required_html
def index():
    #admin_emails = [email.strip().lower() for email in os.getenv("ADMIN_EMAILS", "").split(",") if email.strip()]    
    page = request.args.get('page', 1, type=int)
    show_all = request.args.get('show_all', 'false') == 'true'
    folder_id = request.args.get('folder_id')
    per_page = 100 if not show_all else None

    conn = get_db_connection()
    cur = conn.cursor()
    
    # récupération des fichiers
    files = get_files_for_folder(folder_id, page, per_page)
    total_files = count_files_for_folder(folder_id)
    # récup les dossiers
    cur.execute("SELECT id, name, parent_id FROM folders ORDER BY name;")
    folders = cur.fetchall()
    cur.close()
    conn.close()

    files_data = []
    for doc in files:
        files_data.append({
            'id': doc[0],
            'nom': doc[1],
            'lien': doc[2],
            'description': doc[3] or "No description",
            'tags': parse_tags(doc[4]),
            'is_exclusive': bool(doc[5]) if doc[5] is not None else False,
            'date_ajout': doc[6],
            'date_event': doc[7].strftime("%d-%m-%Y") if doc[7] else None,
            'folder_id': doc[8],
        })

    total_pages = (total_files + per_page - 1) // per_page if per_page else 1

    return render_template(
        "page_canto.html",
        files=files_data,
        current_page=page,
        total_pages=total_pages,
        total_files=total_files,
        show_all=show_all,
        folder_hierarchy=build_folder_hierarchy(folders),
        current_folder_id=folder_id,
        username=session.get('username'),
        user_email=session.get('user_email'),
        is_admin=is_admin(),
    )

@app.route('/json')
@login_required_json
def get_documents_json():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT nom_fichier, lien_telechargement, description, tags, date_event, folder_id
        FROM documents;
    """)
    rows = cur.fetchall()
    cur.close()
    conn.close()

    result = [
        {
            "nom": nom,
            "url": lien,
            "description": description,
            "tags": parse_tags(tags),
            "date_event": date_event.strftime("%m-%d-%Y") if date_event else None,
            "folder_id": folder_id,
        }
        for nom, lien, description, tags, date_event, folder_id in rows
    ]
    return jsonify(result)

@app.route("/download")
@login_required_html
def download_file():
    url = request.args.get("url")
    filename = request.args.get("filename", "file")
    response = requests.get(url)
    file_stream = BytesIO(response.content)
    return send_file(file_stream, as_attachment=True, download_name=filename)

# -----------------------
# Routes dossiers
# -----------------------
@app.route("/get_folders")
@login_required_json
def get_folders():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, name, parent_id FROM folders ORDER BY name;")
    folders = cur.fetchall()
    cur.close()
    conn.close()
    return jsonify({"folders": [{"id": f[0], "name": f[1], "parent_id": f[2]} for f in folders]})

@app.route("/get_files_in_folder/<int:folder_id>")
@login_required_json
def get_files_in_folder(folder_id):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT id, nom_fichier, lien_telechargement
        FROM documents
        WHERE folder_id = %s
        ORDER BY nom_fichier;
    """, (folder_id,))
    files = cur.fetchall()
    cur.close()
    conn.close()
    return jsonify({"files": [{"id": f[0], "name": f[1], "url": f[2]} for f in files]})

@app.route("/create_folder", methods=['POST'])
@login_required_json
def create_folder():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403

    name = request.form.get("name") 
    parent_id = request.form.get("parent_id")
    if not name:
        return jsonify({"status": "error", "message": "Nom du dossier requis"}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "INSERT INTO folders (name, parent_id) VALUES (%s, %s) RETURNING id;",
            (name, parent_id if parent_id else None),
        )
        folder_id = cur.fetchone()[0]
        conn.commit()
        return jsonify({"status": "success", "folder": {"id": folder_id, "name": name, "parent_id": parent_id}})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()

@app.route("/delete_folder", methods=['POST'])
@login_required_json
def delete_folder():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403

    folder_id = request.form.get("folder_id")
    if not folder_id:
        return jsonify({"status": "error", "message": "ID du dossier requis"}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM folders WHERE id = %s;", (folder_id,))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()

@app.route("/update_file_folder", methods=['POST'])
@login_required_json
def update_file_folder():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403

    filename = request.form.get("filename")
    folder_id = request.form.get("folder_id")
    if not filename:
        return jsonify({"status": "error", "message": "Nom de fichier requis"}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        # maj dans documents
        cur.execute(
            "UPDATE documents SET folder_id = %s WHERE nom_fichier = %s;",
            (folder_id if folder_id else None, filename),
        )
        
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()

# -----------------------
# Fichiers (infos et recherche)
# -----------------------
@app.route("/file_details")
@login_required_json
def get_file_details():
    filename = request.args.get("filename")
    if not filename:
        return jsonify({"error": "Filename required"}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    
    # récup infos de base du fichier
    cur.execute("""
        SELECT description, tags, date_ajout, is_exclusive, date_event, folder_id
        FROM documents
        WHERE nom_fichier = %s;
    """, (filename,))
    result = cur.fetchone()
    
    # récup le portail associé s'il existe
    portal_id = None
    cur.execute("""
        SELECT portal_id FROM portal_files WHERE filename = %s LIMIT 1;
    """, (filename,))
    portal_result = cur.fetchone()
    if portal_result:
        portal_id = portal_result[0]
    
    cur.close()
    conn.close()

    if result:
        description, tags, date_ajout, is_exclusive, date_event, folder_id = result
        return jsonify({
            "description": description or "No description",
            "tags": parse_tags(tags),
            "date_ajout": date_ajout.strftime("%d-%m-%Y") if date_ajout else "",
            "is_exclusive": bool(is_exclusive) if is_exclusive is not None else False,
            "date_event": date_event.strftime("%d-%m-%Y") if date_event else "",
            "folder_id": folder_id,
            "portal_id": portal_id  
        })
    return jsonify({"error": "File not found"}), 404

@app.route("/search_file")
@login_required_json
def search_file():
    filename = request.args.get("filename")
    tags = request.args.getlist("tag")
    if not tags and 'tag' in request.args:
        tags = [request.args.get("tag")]
    
    exclusive = request.args.get("exclusive") == "true"
    folder_id = request.args.get("folder_id")

    query = """
        SELECT nom_fichier, lien_telechargement, description, tags, is_exclusive, date_ajout, date_event
        FROM documents
    """
    conditions = []
    params = []

    if filename:
        conditions.append("nom_fichier ILIKE %s")
        params.append(f"%{filename}%")

    if tags:
        tag_conditions = []
        for tag in tags:
            # RECHERCHE SPÉCIFIQUE POUR LE FORMAT ARRAY POSTGRESQL {tag1,tag2}
            tag_conditions.append("tags::text ILIKE %s")
            params.append(f'%{tag}%')
        conditions.append("(" + " OR ".join(tag_conditions) + ")")

    if exclusive:
        conditions.append("is_exclusive = TRUE")
    if folder_id:
        conditions.append("folder_id = %s")
        params.append(folder_id)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)

    query += " ORDER BY nom_fichier;"

    conn = get_db_connection()
    cur = conn.cursor()
    
    try:
        cur.execute(query, params)
        results = cur.fetchall()
    except Exception as e:
        print(f"Error in search query: {str(e)}")
        results = []
    finally:
        cur.close()
        conn.close()

    files = []
    for nom, url, description, tags, is_exclusive, date_ajout, date_event in results:
        files.append({
            "name": nom,
            "url": url,
            "description": description,
            "tags": parse_tags(tags),
            "is_exclusive": bool(is_exclusive) if is_exclusive is not None else False,
            "date_ajout": date_ajout.strftime("%d-%m-%Y") if date_ajout else None,
            "date_event": date_event.strftime("%d-%m-%Y") if date_event else None,
        })

    return jsonify(files)

# -----------------------
# ROUTES ADMIN UNIQUEMENT (UI/POST)
# -----------------------
@app.route("/upload")
@login_required_html
@admin_required
def upload_page():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, name, parent_id FROM folders ORDER BY name;")
    folders = cur.fetchall()
    cur.close()
    conn.close()
    return render_template("upload.html", folders=build_folder_hierarchy(folders))

@app.route("/get_portals_list")
@login_required_json
def get_portals_list():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, name FROM portals ORDER BY name;")
    portals = cur.fetchall()
    cur.close()
    conn.close()
    return jsonify({"portals": [{"id": p[0], "name": p[1]} for p in portals]})

@app.route("/upload", methods=['POST'])
@login_required_json
def upload_file():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403

    files = request.files.getlist("files")
    descriptions = request.form.getlist("descriptions")
    tags_list = request.form.getlist("tags")
    date_events = request.form.getlist("date_events")
    folder_ids = request.form.getlist("folder_ids")
    portal_ids = request.form.getlist("portal_ids") 
    forbidden_extensions = {".heic", ".thm"}

    uploaded_urls = []
    current_date = datetime.now().date()

    for i, file in enumerate(files):
        filename = secure_filename(file.filename)
        ext = os.path.splitext(filename)[1].lower()

        if ext in forbidden_extensions:
            return jsonify({"status": "error", "message": f"Extension '{ext}' non autorisée"}), 400

        description = descriptions[i] if i < len(descriptions) else ""
        tags = json.loads(tags_list[i]) if i < len(tags_list) and tags_list[i] else []
        date_event_str = date_events[i] if i < len(date_events) else None
        folder_id = folder_ids[i] if i < len(folder_ids) else None
        portal_id = portal_ids[i] if i < len(portal_ids) and portal_ids[i] != "none" else None  

        try:
            date_event = datetime.strptime(date_event_str, "%d-%m-%Y").date() if date_event_str else None
        except:
            date_event = None

        # upload vers Azure
        blob_client = blob_service_client.get_blob_client(container=CONTAINER_NAME, blob=filename)
        blob_client.upload_blob(file.stream, overwrite=True)
        blob_url = blob_client.url

        # enregistrement en base
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO documents (
                nom_fichier, lien_telechargement, description, tags, 
                date_ajout, date_event, folder_id
            ) VALUES (%s, %s, %s, %s, %s, %s, %s);
        """, (filename, blob_url, description, json.dumps(tags), current_date, date_event, folder_id))
        
        if portal_id:
            ext = os.path.splitext(filename)[1].lower()
            file_type = "Other"
            if ext in ['.png', '.jpg', '.jpeg', '.gif', '.webp']:
                file_type = "Image"
            elif ext in ['.mp4', '.mov', '.avi', '.wmv']:
                file_type = "Video"
            elif ext in ['.pdf']:
                file_type = "PDF"
            elif ext in ['.doc', '.docx']:
                file_type = "Document"
            elif ext in ['.xls', '.xlsx']:
                file_type = "Spreadsheet"
            
            size_bytes = get_blob_size(filename)
            
            # convertir
            if size_bytes >= 1024 * 1024 * 1024:
                size_display = f"{size_bytes / (1024 * 1024 * 1024):.2f}GB"
            elif size_bytes >= 1024 * 1024:
                size_display = f"{size_bytes / (1024 * 1024):.2f}MB"
            elif size_bytes >= 1024:
                size_display = f"{size_bytes / 1024:.2f}KB"
            else:
                size_display = f"{size_bytes:.0f}Bytes"
            
            cur.execute("""
                INSERT INTO portal_files (portal_id, filename, description, file_url, file_type, upload_date, size_bytes, size)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s);
            """, (
                portal_id, 
                filename, 
                description or "No description", 
                blob_url,
                file_type,
                current_date,
                size_bytes,
                size_display
            ))
            
            update_portal_stats(portal_id)
        
        conn.commit()
        cur.close()
        conn.close()

        uploaded_urls.append(blob_url)

    return jsonify({"status": "success", "urls": uploaded_urls})

@app.route("/delete")
@login_required_html
@admin_required
def delete_page():
    return render_template("delete.html")

@app.route("/delete_file", methods=['POST'])
@login_required_json
def delete_file():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403

    filename = request.form.get("filename")
    confirmation = request.form.get("confirmation") == "on"

    if not confirmation:
        return jsonify({"status": "error", "message": "Confirmation requise"}), 400

    # suppr Azure
    blob_client = blob_service_client.get_blob_client(container=CONTAINER_NAME, blob=filename)
    try:
        blob_client.delete_blob()
    except Exception as e:
        return jsonify({"status": "error", "message": f"Azure error: {str(e)}"}), 500

    # suppr bdd
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("DELETE FROM documents WHERE nom_fichier = %s;", (filename,))
        conn.commit()
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": f"Database error: {str(e)}"}), 500
    finally:
        cur.close()
        conn.close()

    return jsonify({"status": "success", "message": f"Fichier {filename} supprimé"})

@app.route("/update_exclusive", methods=['POST'])
@login_required_json
def update_exclusive():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403

    filename = request.form.get("filename")
    is_exclusive = request.form.get("is_exclusive") == 'true'

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "UPDATE documents SET is_exclusive = %s WHERE nom_fichier = %s RETURNING is_exclusive;",
            (is_exclusive, filename),
        )
        updated_value = cur.fetchone()[0]
        conn.commit()
        return jsonify({
            "status": "success",
            "is_exclusive": bool(updated_value),
        })
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()

# -----------------------
# Fonctions pour les requêtes
# -----------------------
def get_files_for_folder(folder_id=None, page=1, per_page=None):
    conn = get_db_connection()
    cur = conn.cursor()

    if folder_id:
        query = """
            WITH RECURSIVE folder_tree AS (
                SELECT id FROM folders WHERE id = %s
                UNION ALL
                SELECT f.id FROM folders f
                JOIN folder_tree ft ON f.parent_id = ft.id
            )
            SELECT id, nom_fichier, lien_telechargement, description, tags,
                   is_exclusive, date_ajout, date_event, folder_id
            FROM documents
            WHERE folder_id IN (SELECT id FROM folder_tree)
        """
        params = [folder_id]
    else:
        query = """
            SELECT id, nom_fichier, lien_telechargement, description, tags,
                   is_exclusive, date_ajout, date_event, folder_id
            FROM documents
        """
        params = []

    query += " ORDER BY nom_fichier"

    if per_page:
        offset = (page - 1) * per_page
        query += " LIMIT %s OFFSET %s"
        params.extend([per_page, offset])

    cur.execute(query, params)
    files = cur.fetchall()
    cur.close()
    conn.close()
    return files

def count_files_for_folder(folder_id=None):
    conn = get_db_connection()
    cur = conn.cursor()

    if folder_id:
        cur.execute("""
            WITH RECURSIVE folder_tree AS (
                SELECT id FROM folders WHERE id = %s
                UNION ALL
                SELECT f.id FROM folders f
                JOIN folder_tree ft ON f.parent_id = ft.id
            )
            SELECT COUNT(*) FROM documents
            WHERE folder_id IN (SELECT id FROM folder_tree);
        """, (folder_id,))
    else:
        cur.execute("SELECT COUNT(*) FROM documents;")

    count = cur.fetchone()[0]
    cur.close()
    conn.close()
    return count

# -----------------------
# Portals
# -----------------------
@app.route('/portals')
@login_required_html
def portals():
    if session.get('portal_only') and not session.get('user_email'):
        portal_id = session.get('portal_access')
        if portal_id:
            return redirect(url_for('portal_page', portal_id=portal_id))
        
    conn = get_db_connection()
    cur = conn.cursor()
    
    # récup tous les portails avec leurs stats
    cur.execute("SELECT id, name, url, access, creation_date, last_sync FROM portals ORDER BY name;")
    portals_list = []
    
    for portal in cur.fetchall():
        portal_id = portal[0]
        
        # compter les fichiers pour ce portail
        cur2 = conn.cursor()
        cur2.execute("SELECT COUNT(*) FROM portal_files WHERE portal_id = %s;", (portal_id,))
        file_count = cur2.fetchone()[0] or 0
        cur2.close()
        
        cur2 = conn.cursor()
        cur2.execute("SELECT SUM(size_bytes) FROM portal_files WHERE portal_id = %s;", (portal_id,))
        total_bytes_result = cur2.fetchone()
        cur2.close()
        
        total_bytes = total_bytes_result[0] or 0 if total_bytes_result else 0
        
        # convertir 
        if total_bytes >= 1024 * 1024 * 1024:
            total_size = f"{total_bytes / (1024 * 1024 * 1024):.2f}GB"
        elif total_bytes >= 1024 * 1024:
            total_size = f"{total_bytes / (1024 * 1024):.2f}MB"
        elif total_bytes >= 1024:
            total_size = f"{total_bytes / 1024:.2f}KB"
        else:
            total_size = f"{total_bytes:.0f}Bytes"
        
        portals_list.append({
            "id": portal[0],
            "name": portal[1],
            "url": portal[2],
            "access": portal[3],
            "files": file_count,
            "size": total_size,
            "creation_date": portal[4].strftime("%d-%m-%Y") if portal[4] else "",
            "last_sync": portal[5].strftime("%d-%m-%Y") if portal[5] else ""
        })
    
    cur.close()
    conn.close()
    
    return render_template(
        "portals.html", 
        portals=portals_list,
        username=session.get('username'),
        user_email=session.get('user_email'),
        is_admin=is_admin()
    )


@app.route('/add_portal', methods=['POST'])
@login_required_json
@admin_required
def add_portal():
    if not is_admin():
        return jsonify({"status": "error", "message": "Admin access required"}), 403
    
    try:
        data = request.get_json()
        print(f"Received data: {data}")  # debug
        
        name = data.get('name')
        access = data.get('access', 'Public')
        
        print(f"Name: {name}, Access: {access}")  
        
        if not name:
            return jsonify({"status": "error", "message": "Name is required"}), 400
        
        conn = get_db_connection()
        cur = conn.cursor()
        
        # vérif si le portail existe déjà
        cur.execute("SELECT id FROM portals WHERE name = %s;", (name,))
        existing_portal = cur.fetchone()
        
        if existing_portal:
            cur.close()
            conn.close()
            return jsonify({"status": "error", "message": "Portal with this name already exists"}), 400
        
        # créer nouveau portail AVEC l'URL
        cur.execute("""
            INSERT INTO portals (name, url, access, creation_date, last_sync)
            VALUES (%s, %s, %s, CURRENT_DATE, CURRENT_DATE)
            RETURNING id;
        """, (name, '', access))  

        portal_id = cur.fetchone()[0]
        
        slug = generate_slug(name, portal_id)
        url = url_for('portal_by_slug', slug=slug, _external=True)
        
        cur.execute("UPDATE portals SET slug = %s, url = %s WHERE id = %s;", (slug, url, portal_id))
        
        conn.commit()
        cur.close()
        conn.close()
        
        print(f"Portal created successfully with ID: {portal_id}")  
        
        return jsonify({
            "status": "success", 
            "message": "Portal created successfully",
            "portal_id": portal_id
        })
        
    except Exception as e:
        print(f"Error in add_portal: {str(e)}")  # debug
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/update_portal/<int:portal_id>', methods=['POST'])
@login_required_json
@admin_required
def update_portal(portal_id):
    name = request.form.get('name')
    url = request.form.get('url')
    access = request.form.get('access')
    files = request.form.get('files', type=int)
    size = request.form.get('size')
    creation_date = request.form.get('creation_date')
    last_sync = request.form.get('last_sync')
    
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute("""
            UPDATE portals 
            SET name = %s, url = %s, access = %s, files = %s, size = %s, 
                creation_date = %s, last_sync = %s
            WHERE id = %s;
        """, (name, url, access, files, size, creation_date, last_sync, portal_id))
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()

@app.route('/delete_portal/<int:portal_id>', methods=['POST'])
@login_required_json
@admin_required
def delete_portal(portal_id):
    if not is_admin():
        return jsonify({"status": "error", "message": "Admin access required"}), 403
    
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        # supprimer tous les fichiers associés au portail
        cur.execute("DELETE FROM portal_files WHERE portal_id = %s;", (portal_id,))
        
        # puis suppr ce portail 
        cur.execute("DELETE FROM portals WHERE id = %s RETURNING name;", (portal_id,))
        
        deleted_portal = cur.fetchone()
        conn.commit()
        
        if deleted_portal:
            return jsonify({
                "status": "success", 
                "message": f"Portal '{deleted_portal[0]}' deleted successfully"
            })
        else:
            return jsonify({"status": "error", "message": "Portal not found"}), 404
            
    except Exception as e:
        conn.rollback()
        print(f"Error deleting portal: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()

@app.route('/portal/<int:portal_id>')
@login_required_html
def portal_page(portal_id):
    user_email = session.get('portal_user_email', '')
    portal_access_id = session.get('portal_access')

    if not user_email or portal_access_id != portal_id:
        return redirect(url_for('portal_login', portal_id=portal_id))
    
    if not has_portal_access(user_email, portal_id):
        return render_template("403.html"), 403
    
    #admin_emails = [email.strip().lower() for email in os.getenv("ADMIN_EMAILS", "").split(",") if email.strip()]    
    session['next'] = request.url
    conn = get_db_connection()
    cur = conn.cursor()

    
    # infos du portail
    cur.execute("SELECT id, name, url, access, creation_date, last_sync FROM portals WHERE id = %s;", (portal_id,))
    portal = cur.fetchone()
    
    if not portal:
        flash("Portal not found", "error")
        return redirect(url_for('portals'))
    
    # récup les fichiers associés à ce portail AVEC TOUTES LES INFORMATIONS
    cur.execute("""
        SELECT pf.id, pf.filename, pf.description, pf.size_bytes, pf.upload_date, 
               pf.file_url, pf.file_type, d.tags, d.is_exclusive, d.folder_id,
               d.date_event
        FROM portal_files pf
        LEFT JOIN documents d ON pf.filename = d.nom_fichier
        WHERE pf.portal_id = %s 
        ORDER BY pf.filename;
    """, (portal_id,))
    files = cur.fetchall()
    
    file_count = len(files)
    
    total_bytes = sum(file[3] or 0 for file in files)
    
    # convertir
    if total_bytes >= 1024 * 1024 * 1024:
        total_size = f"{total_bytes / (1024 * 1024 * 1024):.2f}GB"
    elif total_bytes >= 1024 * 1024:
        total_size = f"{total_bytes / (1024 * 1024):.2f}MB"
    elif total_bytes >= 1024:
        total_size = f"{total_bytes / 1024:.2f}KB"
    else:
        total_size = f"{total_bytes:.0f}Bytes"
    
    portal_data = {
        "id": portal[0],
        "name": portal[1],
        "url": portal[2],
        "access": portal[3],
        "files_count": file_count,
        "size": total_size,
        "creation_date": portal[4].strftime("%d-%m-%Y") if portal[4] else "",
        "last_sync": portal[5].strftime("%d-%m-%Y") if portal[5] else ""
    }
    
    files_data = []
    for file in files:
        size_bytes = file[3] or 0
        # convertir 
        if size_bytes >= 1024 * 1024 * 1024:
            size_display = f"{size_bytes / (1024 * 1024 * 1024):.2f}GB"
        elif size_bytes >= 1024 * 1024:
            size_display = f"{size_bytes / (1024 * 1024):.2f}MB"
        elif size_bytes >= 1024:
            size_display = f"{size_bytes / 1024:.2f}KB"
        else:
            size_display = f"{size_bytes:.0f}Bytes"
        
        files_data.append({
            "id": file[0],
            "filename": file[1],
            "description": file[2] or "No description",
            "size_bytes": size_bytes,
            "size_display": size_display,
            "upload_date": file[4].strftime("%d-%m-%Y") if file[4] else "",
            "file_url": file[5],
            "file_type": file[6] or "Unknown",
            "tags": parse_tags(file[7]),
            "is_exclusive": bool(file[8]) if file[8] is not None else False,
            "folder_id": file[9],
            "event_date": file[10].strftime("%d-%m-%Y") if file[10] else None
        })
    
    cur.close()
    conn.close()
    
    return render_template(
        "portal_page.html",
        portal=portal_data,
        files=files_data,
        username=session.get('username'),
        user_email=session.get('user_email'),
        is_admin=is_admin(),
        #admin_emails=json.dumps(admin_emails)
    )

def update_portal_stats(portal_id):
    conn = get_db_connection()
    cur = conn.cursor()
    
    # compter les fichiers et additionner les tailles
    cur.execute("""
        SELECT COUNT(*), SUM(size_bytes) 
        FROM portal_files 
        WHERE portal_id = %s;
    """, (portal_id,))
    
    result = cur.fetchone()
    file_count = result[0] or 0
    total_bytes = result[1] or 0
    
    # convertir
    if total_bytes >= 1024 * 1024 * 1024:
        total_size = f"{total_bytes / (1024 * 1024 * 1024):.2f}GB"
    elif total_bytes >= 1024 * 1024:
        total_size = f"{total_bytes / (1024 * 1024):.2f}MB"
    elif total_bytes >= 1024:
        total_size = f"{total_bytes / 1024:.2f}KB"
    else:
        total_size = f"{total_bytes:.0f}Bytes"
    
    # maj le portail
    cur.execute("""
        UPDATE portals 
        SET files = %s, size = %s, last_sync = CURRENT_DATE 
        WHERE id = %s;
    """, (file_count, total_size, portal_id))
    
    conn.commit()
    cur.close()
    conn.close()
    
    return file_count, total_size

@app.route("/get_portals")
@login_required_json
def get_portals():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, name FROM portals ORDER BY name;")
    portals = cur.fetchall()
    cur.close()
    conn.close()
    return jsonify({"portals": [{"id": p[0], "name": p[1]} for p in portals]})

@app.route("/update_file_portal", methods=['POST'])
@login_required_json
def update_file_portal():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403

    filename = request.form.get("filename")
    portal_id = request.form.get("portal_id")
    
    if not filename:
        return jsonify({"status": "error", "message": "Nom de fichier requis"}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        # verifie si le fichier existe deja dans portal_files
        cur.execute(
            "SELECT id FROM portal_files WHERE filename = %s AND portal_id = %s;",
            (filename, portal_id)
        )
        existing_file = cur.fetchone()
        
        if existing_file:
            return jsonify({"status": "success", "message": "File already in portal"})
        
        # récup les informations du fichier depuis documents
        cur.execute(
            "SELECT nom_fichier, lien_telechargement, description, tags, date_ajout, date_event FROM documents WHERE nom_fichier = %s;",
            (filename,)
        )
        file_info = cur.fetchone()
        
        if not file_info:
            return jsonify({"status": "error", "message": "File not found"}), 404
        
        nom_fichier, lien_telechargement, description, tags, date_ajout, date_event = file_info
        
        ext = os.path.splitext(nom_fichier)[1].lower()
        file_type = "Other"
        if ext in ['.png', '.jpg', '.jpeg', '.gif', '.webp']:
            file_type = "Image"
        elif ext in ['.mp4', '.mov', '.avi', '.wmv']:
            file_type = "Video"
        elif ext in ['.pdf']:
            file_type = "PDF"
        elif ext in ['.doc', '.docx']:
            file_type = "Document"
        elif ext in ['.xls', '.xlsx']:
            file_type = "Spreadsheet"
        
        # taille du fichier
        size_bytes = get_blob_size(nom_fichier)
        
        # convertir
        if size_bytes >= 1024 * 1024 * 1024:
            size_display = f"{size_bytes / (1024 * 1024 * 1024):.2f}GB"
        elif size_bytes >= 1024 * 1024:
            size_display = f"{size_bytes / (1024 * 1024):.2f}MB"
        elif size_bytes >= 1024:
            size_display = f"{size_bytes / 1024:.2f}KB"
        else:
            size_display = f"{size_bytes:.0f}Bytes"
        
        cur.execute("""
            INSERT INTO portal_files (portal_id, filename, description, file_url, file_type, upload_date, size_bytes, size)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s);
        """, (
            portal_id, 
            nom_fichier, 
            description or "No description", 
            lien_telechargement,
            file_type,
            date_ajout or datetime.now().date(),
            size_bytes,
            size_display
        ))
        
        conn.commit()        
        update_portal_stats(portal_id)
        
        return jsonify({"status": "success"})
    except psycopg2.IntegrityError:
        conn.rollback()
        return jsonify({"status": "success", "message": "File already in portal"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()


@app.route('/portal/<int:portal_id>/stats')
@login_required_json
def get_portal_stats(portal_id):
    conn = get_db_connection()
    cur = conn.cursor()
    
    try:
        # compter les fichiers 
        cur.execute("SELECT COUNT(*) FROM portal_files WHERE portal_id = %s;", (portal_id,))
        file_count = cur.fetchone()[0] or 0
        
        # calcule la taille totale
        cur.execute("SELECT SUM(size_bytes) FROM portal_files WHERE portal_id = %s;", (portal_id,))
        total_bytes_result = cur.fetchone()
        total_bytes = total_bytes_result[0] or 0 if total_bytes_result else 0
        
        # convertir
        if total_bytes >= 1024 * 1024 * 1024:
            total_size = f"{total_bytes / (1024 * 1024 * 1024):.2f}GB"
        elif total_bytes >= 1024 * 1024:
            total_size = f"{total_bytes / (1024 * 1024):.2f}MB"
        elif total_bytes >= 1024:
            total_size = f"{total_bytes / 1024:.2f}KB"
        else:
            total_size = f"{total_bytes:.0f}Bytes"
        
        return jsonify({
            "status": "success",
            "files_count": file_count,
            "total_size": total_size,
            "total_bytes": total_bytes
        })
        
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()

@app.route("/get_portal_files/<int:portal_id>")
@login_required_json
def get_portal_files(portal_id):
    conn = get_db_connection()
    cur = conn.cursor()
    
    try:
        cur.execute("""
            SELECT filename FROM portal_files WHERE portal_id = %s;
        """, (portal_id,))
        files = cur.fetchall()
        
        return jsonify({"files": [f[0] for f in files]})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()

@app.route("/remove_file_from_portal", methods=['POST'])
@login_required_json
def remove_file_from_portal():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403

    filename = request.form.get("filename")
    portal_id = request.form.get("portal_id")
    
    if not filename or not portal_id:
        return jsonify({"status": "error", "message": "Filename and portal ID are required"}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "DELETE FROM portal_files WHERE filename = %s AND portal_id = %s;",
            (filename, portal_id)
        )
        conn.commit()
        
        cur.execute("SELECT COUNT(*) FROM portal_files WHERE portal_id = %s;", (portal_id,))
        remaining_files = cur.fetchone()[0]
        
        if remaining_files > 0:
            update_portal_stats(portal_id)
        else:
            cur.execute("""
                UPDATE portals 
                SET files = 0, size = '0Bytes', last_sync = CURRENT_DATE 
                WHERE id = %s;
            """, (portal_id,))
            conn.commit()
        
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()

def get_blob_size(blob_name):
    try:
        blob_client = blob_service_client.get_blob_client(container=CONTAINER_NAME, blob=blob_name)
        properties = blob_client.get_blob_properties()
        return properties.size
    except Exception as e:
        print(f"Error getting blob size for {blob_name}: {str(e)}")
        return 0
    
@app.route("/update_portal_files_sizes")
@login_required_json
@admin_required
def update_portal_files_sizes():
    """Met à jour les tailles de tous les fichiers dans portal_files"""
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403
    
    conn = get_db_connection()
    cur = conn.cursor()
    
    try:
        cur.execute("SELECT id, filename FROM portal_files;")
        files = cur.fetchall()
        
        updated_count = 0
        for file_id, filename in files:
            size_bytes = get_blob_size(filename)
            
            if size_bytes >= 1024 * 1024 * 1024:
                size_display = f"{size_bytes / (1024 * 1024 * 1024):.2f}GB"
            elif size_bytes >= 1024 * 1024:
                size_display = f"{size_bytes / (1024 * 1024):.2f}MB"
            elif size_bytes >= 1024:
                size_display = f"{size_bytes / 1024:.2f}KB"
            else:
                size_display = f"{size_bytes:.0f}Bytes"
            
            cur.execute(
                "UPDATE portal_files SET size_bytes = %s, size = %s WHERE id = %s;",
                (size_bytes, size_display, file_id)
            )
            updated_count += 1
        
        conn.commit()
        
        cur.execute("SELECT id FROM portals;")
        portals = cur.fetchall()
        for portal_id in portals:
            update_portal_stats(portal_id[0])
        
        return jsonify({
            "status": "success", 
            "message": f"Updated sizes for {updated_count} files"
        })
        
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()

@app.route("/remove_file_from_folder", methods=['POST'])
@login_required_json
def remove_file_from_folder():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403

    filename = request.form.get("filename")
    if not filename:
        return jsonify({"status": "error", "message": "Nom de fichier requis"}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "UPDATE documents SET folder_id = NULL WHERE nom_fichier = %s;",
            (filename,),
        )
        
        
        conn.commit()
        return jsonify({"status": "success"})
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()

@app.route("/sync_file_folder", methods=['POST'])
@login_required_json
def sync_file_folder():
    if not is_admin():
        return jsonify({"error": "Forbidden"}), 403

    filename = request.form.get("filename")
    if not filename:
        return jsonify({"status": "error", "message": "Nom de fichier requis"}), 400

    conn = get_db_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT folder_id FROM documents WHERE nom_fichier = %s;",
            (filename,),
        )
        result = cur.fetchone()
        current_folder_id = result[0] if result else None
        
        conn.commit()
        return jsonify({
            "status": "success", 
            "has_folder": current_folder_id is not None,
            "folder_id": current_folder_id
        })
    except Exception as e:
        conn.rollback()
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        cur.close()
        conn.close()

@app.route("/get_portal_url/<int:portal_id>")
@login_required_json
def get_portal_url(portal_id):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT slug FROM portals WHERE id = %s;", (portal_id,))
    result = cur.fetchone()
    cur.close()
    conn.close()
    
    if result and result[0]:
        portal_url = url_for('portal_by_slug', slug=result[0], _external=True)
        return jsonify({"status": "success", "url": portal_url})
    return jsonify({"status": "error", "message": "Slug not found"}), 404

@app.route('/portals/<slug>')
def portal_by_slug(slug):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, name, access FROM portals WHERE slug = %s;", (slug,))
    result = cur.fetchone()
    cur.close()
    conn.close()
    
    if not result:
        flash("Portal not found", "error")
        return redirect(url_for('portals'))
    
    portal_id, portal_name, portal_access = result
    has_portal_session = (
        session.get('portal_access') == portal_id and 
        session.get('portal_user_email')
    )
    
    if not has_portal_session:
        return redirect(url_for('portal_login', portal_id=portal_id))
    
    return redirect(url_for('portal_page', portal_id=portal_id))

@app.route('/portal_logout_only/<int:portal_id>')
def portal_logout_only(portal_id):
    session.pop('portal_user_id', None)
    session.pop('portal_user_email', None)
    session.pop('portal_access', None)
    session.pop('portal_only', None)
    
    return jsonify({
        "status": "success", 
        "redirect_url": url_for('portal_login', portal_id=portal_id)
    })

@app.route("/generate_slugs")
@admin_required
def generate_slugs():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, name FROM portals WHERE slug IS NULL;")
    portals = cur.fetchall()
    
    for portal_id, name in portals:
        slug = generate_slug(name, portal_id)
        cur.execute("UPDATE portals SET slug = %s WHERE id = %s;", (slug, portal_id))
    
    conn.commit()
    cur.close()
    conn.close()
    
    return jsonify({"status": "success", "message": f"Slugs générés pour {len(portals)} portails"})

@app.route('/portal/<int:portal_id>/login', methods=['GET', 'POST'])
def portal_login(portal_id):
    if (session.get('portal_access') == portal_id and 
        session.get('portal_user_email') and 
        not request.args.get('force')):
        return redirect(url_for('portal_page', portal_id=portal_id))
    session.pop('next', None)
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT name FROM portals WHERE id = %s;", (portal_id,))
    portal = cur.fetchone()
    
    if not portal:
        flash("Portal not found", "error")
        return redirect(url_for('portals'))
    
    portal_name = portal[0]
    
    error = None
    if request.method == 'POST':
        if 'reset_request' in request.form:
            email = request.form.get('reset_email', '').lower().strip()
            
            cur.execute("SELECT id FROM portal_users WHERE email = %s AND portal_id = %s;", (email, portal_id))
            user = cur.fetchone()
            
            if user:
                token = secrets.token_urlsafe(32)
                expiry = datetime.now() + timedelta(hours=24)
                
                cur.execute("""
                    UPDATE portal_users 
                    SET reset_token = %s, reset_token_expiry = %s 
                    WHERE email = %s AND portal_id = %s;
                """, (token, expiry, email, portal_id))
                conn.commit()
                
                reset_url = url_for('portal_reset_password', portal_id=portal_id, token=token, _external=True)
                subject = f"Resetting your password - {portal_name}"
                body = f"""
                Hello,

                You have requested to reset your password for the {portal_name} portal.

                Please click the following link to set a new password:

                {reset_url}

                This link will expire in 24 hours.

                Sincerely,
                The Media Library Team
                """
                
                if send_email(email, subject, body):
                    flash("A reset email has been sent", "success")
                else:
                    flash("Error sending email", "error")
            else:
                flash("Email not found for this portal", "error")
            
            cur.close()
            conn.close()
            return render_template('portal_login.html', portal_id=portal_id, portal_name=portal_name, error=error)
        
        email = request.form.get('email', '').lower().strip()
        password = request.form.get('password', '')
        
        if has_portal_access(email, portal_id, password):
            cur.execute("SELECT id FROM portal_users WHERE email = %s AND portal_id = %s;", (email, portal_id))
            user = cur.fetchone()
            
            if user:
                user_id = user[0]
                session['portal_user_id'] = user_id
                session['portal_user_email'] = email
                session['portal_access'] = portal_id
                
                cur.execute("UPDATE portal_users SET last_login = NOW() WHERE id = %s;", (user_id,))
                conn.commit()
                
                flash("Connection successful", "success")
                cur.close()
                conn.close()
                #return redirect(url_for('portal_page', portal_id=portal_id))
                next_url = session.pop('next', None) or url_for('portal_page', portal_id=portal_id)
                return redirect(next_url)
        else:
            cur.execute("SELECT id FROM portal_users WHERE email = %s AND portal_id = %s;", (email, portal_id))
            user_exists = cur.fetchone() is not None
            
            if user_exists:
                error = "Incorrect password"
            else:
                cur.close()
                conn.close()
                return render_template("403.html"), 403
    
    cur.close()
    conn.close()
    
    return render_template('portal_login.html', portal_id=portal_id, portal_name=portal_name, error=error)

@app.route('/portal/<int:portal_id>/request_reset', methods=['GET', 'POST'])
def portal_request_reset(portal_id):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT name FROM portals WHERE id = %s;", (portal_id,))
    portal = cur.fetchone()
    
    if not portal:
        flash("Portal not found", "error")
        return redirect(url_for('portals'))
    
    portal_name = portal[0]
    
    if request.method == 'POST':
        email = request.form.get('email', '').lower().strip()
        
        cur.execute("SELECT id FROM portal_users WHERE email = %s AND portal_id = %s;", (email, portal_id))
        user = cur.fetchone()
        
        if user:
            token = secrets.token_urlsafe(32)
            expiry = datetime.now() + timedelta(hours=24)
            
            cur.execute("""
                UPDATE portal_users 
                SET reset_token = %s, reset_token_expiry = %s 
                WHERE email = %s AND portal_id = %s;
            """, (token, expiry, email, portal_id))
            conn.commit()
            
            reset_url = url_for('portal_reset_password', portal_id=portal_id, token=token, _external=True)
            subject = f"Resetting your password - {portal_name}"
            body = f"""
            Hello,

            You have requested to reset your password for the {portal_name} portal.

            Please click the following link to set a new password:

            {reset_url}

            This link will expire in 24 hours.

            Sincerely,
            The Media Library Team
            """
            
            if send_email(email, subject, body):
                flash("A reset email has been sent", "success")
                return redirect(url_for('portal_login', portal_id=portal_id))
            else:
                flash("Error sending email", "error")
        else:
            flash("Email not found for this portal", "error")
    
    cur.close()
    conn.close()
    
    return render_template('portal_request_reset.html', portal_id=portal_id, portal_name=portal_name)


@app.route('/portal/<int:portal_id>/reset_password/<token>', methods=['GET', 'POST'])
def portal_reset_password(portal_id, token):
    conn = get_db_connection()
    cur = conn.cursor()
    
    cur.execute("""
        SELECT id, email FROM portal_users 
        WHERE reset_token = %s AND reset_token_expiry > NOW() AND portal_id = %s;
    """, (token, portal_id))
    
    user = cur.fetchone()
    
    if not user:
        flash("Invalid or expired link", "error")
        cur.close()
        conn.close()
        return redirect(url_for('portal_login', portal_id=portal_id))
    
    user_id, email = user
    
    if request.method == 'POST':
        password = request.form.get('password')
        confirm_password = request.form.get('confirm_password')
        
        if password != confirm_password:
            flash("Passwords do not match", "error")
        elif len(password) < 8:
            flash("Password must contain at least 8 characters", "error")
        else:
            hashed_password = generate_password_hash(password)
            
            cur.execute("""
                UPDATE portal_users 
                SET password = %s, reset_token = NULL, reset_token_expiry = NULL 
                WHERE id = %s;
            """, (hashed_password, user_id))
            conn.commit()
            
            flash("Password updated successfully", "success")
            cur.close()
            conn.close()
            return redirect(url_for('portal_login', portal_id=portal_id))
    
    cur.close()
    conn.close()
    
    return render_template('portal_reset_password.html', portal_id=portal_id, token=token, email=email)

def send_password_setup_email(email, portal_id):
    token = secrets.token_urlsafe(32)
    
    conn = get_db_connection()
    cur = conn.cursor()
    
    expiry = datetime.now() + timedelta(hours=24)
    cur.execute("""
        UPDATE portal_users 
        SET reset_token = %s, reset_token_expiry = %s 
        WHERE email = %s AND portal_id = %s;
    """, (token, expiry, email, portal_id))
    conn.commit()
    
    cur.close()
    conn.close()
    
    reset_url = url_for('portal_reset_password', portal_id=portal_id, token=token, _external=True)
    
    subject = "Setting your password - Media Portal"
    body = f"""
    Hello,

    You have requested access to the Media Portal.
    Please click the link below to set your password:

    {reset_url}

    This link will expire in 24 hours.

    Sincerely,
    The Media Library Team
    """
    
    send_email(email, subject, body)


def send_password_reset_email(email, portal_id):
    send_password_setup_email(email, portal_id)


def has_portal_access(email, portal_id, password=None):
    conn = get_db_connection()
    cur = conn.cursor()
    
    if password:
        cur.execute("""
            SELECT id, password FROM portal_users 
            WHERE email = %s AND portal_id = %s;
        """, (email.lower(), portal_id))
        
        user = cur.fetchone()
        cur.close()
        conn.close()
        
        if user:
            user_id, hashed_password = user
            return check_password_hash(hashed_password, password)
        return False
    else:
        cur.execute("""
            SELECT id FROM portal_users 
            WHERE email = %s AND portal_id = %s;
        """, (email.lower(), portal_id))
        
        user_exists = cur.fetchone() is not None
        cur.close()
        conn.close()
        
        return user_exists

def send_email(to_email, subject, body):
    try:
        authority = f"https://login.microsoftonline.com/{TENANT_ID}"
        app = msal.ConfidentialClientApplication(
            CLIENT_ID,
            authority=authority,
            client_credential=CLIENT_SECRET
        )
        
        result = app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
        
        if "access_token" in result:
            access_token = result['access_token']
            email_msg = {
                "message": {
                    "subject": subject,
                    "body": {
                        "contentType": "Text",
                        "content": body
                    },
                    "toRecipients": [
                        {
                            "emailAddress": {
                                "address": to_email
                            }
                        }
                    ],
                    "from": {
                        "emailAddress": {
                            "address": SMTP_USERNAME,
                            "name": "Media Library"  
                        }
                    }
                },
                "saveToSentItems": "true"
            }
            endpoint = f'https://graph.microsoft.com/v1.0/users/{SMTP_USERNAME}/sendMail'
            headers = {
                'Authorization': 'Bearer ' + access_token,
                'Content-Type': 'application/json'
            }
            response = requests.post(endpoint, headers=headers, json=email_msg)
            
            if response.status_code == 202:
                print(f"Email envoyé à {to_email}")
                return True
            else:
                print(f"Erreur sur le graph API: {response.status_code} - {response.text}")
                return False
        else:
            print(f"Erreur d'authentification: {result.get('error_description')}")
            return False
            
    except Exception as e:
        print(f"Erreur lors de l'envoi via Graph API: {str(e)}")
        return False


#send_email("david.guney@pur.co", "Sujet test", "Ceci est un email envoyé via Graph API test")

@app.route('/portal/<int:portal_id>/logout', methods=['POST'])
def portal_logout(portal_id):
    if session.get('portal_only'):
        session.clear()
        response = jsonify({
            "status": "success", 
            "redirect_url": url_for('portals')
        })
    else:
        session.pop('portal_user_id', None)
        session.pop('portal_user_email', None)
        session.pop('portal_access', None)
        response = jsonify({
            "status": "success", 
            "redirect_url": url_for('portal_login', portal_id=portal_id)
        })
    
    return response

@app.route("/get_portal_slug/<int:portal_id>")
@login_required_json
def get_portal_slug(portal_id):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT slug FROM portals WHERE id = %s;", (portal_id,))
    result = cur.fetchone()
    cur.close()
    conn.close()
    
    if result and result[0]:
        return jsonify({"status": "success", "slug": result[0]})
    return jsonify({"status": "error", "message": "Slug not found"}), 404

def send_reset_email(user_email, reset_link):
    msg = EmailMessage()
    msg.set_content(f"Cliquez ici pour réinitialiser : {reset_link}")
    msg['Subject'] = "Réinitialisation de mot de passe"
    msg['From'] = os.getenv('SMTP_USERNAME')
    msg['To'] = user_email

    try:
        server = smtplib.SMTP(os.getenv('SMTP_SERVER'), int(os.getenv('SMTP_PORT')))
        server.starttls() 
        server.login(os.getenv('SMTP_USERNAME'), os.getenv('SMTP_PASSWORD'))
        server.send_message(msg)
        server.quit()
        return True
    except Exception as e:
        print(f"Erreur d'envoi d'email: {e}")
        return False
    
from flask import jsonify

@app.route('/get_all_portals', methods=['GET'])
def api_get_all_portals():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, name FROM portals ORDER BY name ASC;")
    portals = [{"id": row[0], "name": row[1]} for row in cur.fetchall()]
    cur.close()
    conn.close()
    return jsonify({"portals": portals})

@app.route('/get_folders', methods=['GET'])
def api_get_folders():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, name FROM folders ORDER BY name ASC;")
    folders = [{"id": row[0], "name": row[1]} for row in cur.fetchall()]
    cur.close()
    conn.close()
    return jsonify({"folders": folders})

if __name__ == '__main__':
    app.run(debug=True)