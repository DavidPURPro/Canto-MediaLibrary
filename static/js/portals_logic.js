// gestion des portails clients cote admin (creation, delete, et link des folders)
document.addEventListener('DOMContentLoaded', () => {
    setProfileButtonColor();
    initHeaderBubbles();
    initStaggeredReveal();
    setupEventListeners();
    setupModals();
});

// colorie le bouton de profil en fonction du role
function setProfileButtonColor() {
  const profileBtn = document.getElementById('profileBtn');
  if (profileBtn) {
    const userRole = document.body.getAttribute('data-user-role');
    const isAdmin = document.body.getAttribute('data-is-admin') === 'true' || typeof window.isAdmin !== 'undefined' && window.isAdmin;
    profileBtn.style.border = '2px solid #ffffff';
    profileBtn.style.boxShadow = '0 2px 5px rgba(0,0,0,0.15)'; 
    if (userRole === 'admin' || isAdmin) {
      profileBtn.style.backgroundColor = '#d9534f'; 
      profileBtn.title = "Administrator";
      profileBtn.addEventListener('mouseenter', () => { profileBtn.style.backgroundColor = '#c9302c'; });
      profileBtn.addEventListener('mouseleave', () => { profileBtn.style.backgroundColor = '#d9534f'; });
    } 

    else if (userRole === 'basic_admin') {
      profileBtn.style.backgroundColor = '#3b82f6';
      profileBtn.title = "Moderator";
      profileBtn.addEventListener('mouseenter', () => { profileBtn.style.backgroundColor = '#2563eb'; });
      profileBtn.addEventListener('mouseleave', () => { profileBtn.style.backgroundColor = '#3b82f6'; });
    }
    
    else if (userRole === 'uploader') {
      profileBtn.style.backgroundColor = '#f97316'; 
      profileBtn.title = "Uploader";
      profileBtn.addEventListener('mouseenter', () => { profileBtn.style.backgroundColor = '#ea580c'; });
      profileBtn.addEventListener('mouseleave', () => { profileBtn.style.backgroundColor = '#f97316'; });
    }
    else {
      const initials = profileBtn.textContent.trim();
      let hash = 0;
      for (let i = 0; i < initials.length; i++) {
        hash = initials.charCodeAt(i) + ((hash << 5) - hash);
      }
      const safeHue = (Math.abs(hash) % 290) + 30; 
      const color = `hsl(${safeHue}, 85%, 55%)`;
      const hoverColor = `hsl(${safeHue}, 85%, 45%)`; 
      profileBtn.style.backgroundColor = color;
      
      profileBtn.addEventListener('mouseenter', () => { profileBtn.style.backgroundColor = hoverColor; });
      profileBtn.addEventListener('mouseleave', () => { profileBtn.style.backgroundColor = color; });
    }
  }
}

// petit effet d'apparition decalee ( staggered reveal ) pour les cards
function initStaggeredReveal() {
    const cards = document.querySelectorAll('.portal-card-modern');
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                cards.forEach((card, index) => {
                    setTimeout(() => {
                        card.style.opacity = "1";
                        card.style.transform = "translateY(0)";
                        setTimeout(() => {
                            card.style.transition = "var(--transition)";
                        }, 800);
                    }, index * 100); 
                });
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });

    const grid = document.getElementById('portalsGrid');
    if (grid) observer.observe(grid);
}

function initHeaderBubbles() {
    const container = document.getElementById('headerBubbles');
    if (!container) return;
    for (let i = 0; i < 15; i++) {
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        const size = Math.random() * 40 + 10;
        bubble.style.width = `${size}px`;
        bubble.style.height = `${size}px`;
        bubble.style.left = `${Math.random() * 100}%`;
        bubble.style.top = `${Math.random() * 100}%`;
        bubble.style.animationDelay = `${Math.random() * 8}s`;
        bubble.style.animationDuration = `${10 + Math.random() * 10}s`;
        container.appendChild(bubble);
    }
}

function setupEventListeners() {
    const profileBtn = document.getElementById('profileBtn');
    const profileDropdown = document.getElementById('profileDropdown');
    
    if (profileBtn && profileDropdown) {
        profileBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            profileDropdown.classList.toggle('active');
        });
        
        document.addEventListener('click', () => {
            profileDropdown.classList.remove('active');
        });
    }

    document.querySelectorAll('.btn-copy-link-circle').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation(); 
            const id = btn.dataset.id;
            try {
                const response = await fetch(`/get_portal_url/${id}`);
                const data = await response.json();
                await navigator.clipboard.writeText(data.url);
                const icon = btn.querySelector('i');
                icon.className = 'fas fa-check';
                btn.style.background = '#0ca678';
                btn.style.borderColor = '#0ca678';
                btn.style.color = 'white';
                setTimeout(() => {
                    icon.className = 'fas fa-link';
                    btn.style.background = '';
                    btn.style.borderColor = '';
                    btn.style.color = '';
                }, 2000);
            } catch (err) {
                console.error("Erreur copie :", err);
            }
        });
    });
}

let portalToDeleteId = null;

// setup des modals ( ouvrir et fermer au clic )
function setupModals() {
    const addPortalBtn = document.getElementById('addPortalBtn');
    const addModal = document.getElementById('addPortalModal');
    const deleteModal = document.getElementById('deletePortalModal');
    const closeBtns = document.querySelectorAll('.close-modal-btn');
    const portalForm = document.getElementById('portalForm');
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');

    if (addPortalBtn && addModal) {
        addPortalBtn.addEventListener('click', () => {
            if (!addPortalBtn.classList.contains('disabled')) {
                addModal.classList.add('active');
            }
        });
    }

    const closeModal = () => {
        if(addModal) addModal.classList.remove('active');
        if(deleteModal) deleteModal.classList.remove('active');
        portalToDeleteId = null;
    };

    closeBtns.forEach(btn => btn.addEventListener('click', closeModal));
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modern-modal-overlay')) closeModal();
    });

    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', () => {
            if (!portalToDeleteId) return;
            fetch(`/delete_portal/${portalToDeleteId}`, { method: 'POST' })
                .then(() => window.location.reload());
        });
    }
}

function initAboutModal() {
    const aboutModal = document.getElementById('aboutModal');
    const openBtn = document.getElementById('openAboutBtn');
    const closeBtn = document.getElementById('closeAboutBtn');
    const profileDropdown = document.getElementById('profileDropdown');
    if (!aboutModal) return; 
    if (openBtn) {
        openBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            aboutModal.classList.add('active');
            if (profileDropdown) {
                profileDropdown.classList.remove('active');
            }
        });
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            aboutModal.classList.remove('active');
        });
    }
    window.addEventListener('click', (e) => {
        if (e.target === aboutModal) {
            aboutModal.classList.remove('active');
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && aboutModal.classList.contains('active')) {
            aboutModal.classList.remove('active');
        }
    });
}

initAboutModal();

window.prepareDelete = (id, name) => {
    portalToDeleteId = id;
    document.getElementById('portalToDeleteName').textContent = name;
    document.getElementById('deletePortalModal').classList.add('active');
};

window.closeDeleteModal = () => {
    document.getElementById('deletePortalModal').classList.remove('active');
};

// charger dossiers sous forme de cases à cocher
document.addEventListener('DOMContentLoaded', () => {
    fetch('/get_folders')
        .then(res => res.json())
        .then(data => {
            const checklistNew = document.getElementById('newPortalFoldersChecklist');
            const checklistExisting = document.getElementById('existingPortalFoldersChecklist');
            
            // Populate Root Folder selection trees in hierarchy/arborescence order
            const rootTreeContainer = document.getElementById('portalRootFolderTree');
            const existRootTreeContainer = document.getElementById('existingPortalRootFolderTree');

            function createRootFolderTreeNode(folder, prefixId, radioName) {
                const node = document.createElement('div');
                node.style.marginLeft = folder.parent_id ? '25px' : '0px';
                node.style.marginTop = '4px';
                const header = document.createElement('div');
                header.style.display = 'flex';
                header.style.alignItems = 'center';
                header.style.gap = '8px';
                const hasChildren = folder.subfolders && folder.subfolders.length > 0;
                const chevronHtml = hasChildren 
                    ? '<i class="fas fa-chevron-right chevron-toggle" style="width:15px; cursor:pointer; color:#94a3b8; text-align:center;" title="Expand"></i>' 
                    : '<span style="width:15px; display:inline-block;"></span>';
                
                header.innerHTML = `
                    ${chevronHtml}
                    <label style="display:flex; align-items:center; gap:8px; cursor:pointer; color:#334155; font-weight:500; margin:0; flex-grow:1;">
                        <input type="radio" name="${radioName}" value="${folder.id}" id="${prefixId}_root_${folder.id}" style="width:16px; height:16px; cursor:pointer; flex-shrink:0;">
                        <span style="user-select:none;"><i class="far fa-folder" style="color:#1e293b; margin-right:6px;"></i>${folder.name}</span>
                    </label>
                `;

                const childrenContainer = document.createElement('div');
                childrenContainer.style.display = 'none';
                if (hasChildren) {
                    folder.subfolders.forEach(sub => childrenContainer.appendChild(createRootFolderTreeNode(sub, prefixId, radioName)));
                }

                const chevron = header.querySelector('.chevron-toggle');
                if (chevron) {
                    chevron.addEventListener('click', (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        const isHidden = childrenContainer.style.display === 'none';
                        childrenContainer.style.display = isHidden ? 'block' : 'none';
                        chevron.className = isHidden ? 'fas fa-chevron-down chevron-toggle' : 'fas fa-chevron-right chevron-toggle';
                    });
                }
                node.appendChild(header);
                node.appendChild(childrenContainer);
                return node;
            }

            if (data.folders && data.folders.length > 0) {
                const folderMap = {};
                data.folders.forEach(f => folderMap[f.id] = { ...f, subfolders: [] });
                Object.values(folderMap).forEach(f => {
                    if (f.parent_id && folderMap[f.parent_id]) {
                        folderMap[f.parent_id].subfolders.push(f);
                    }
                });

                function createTreeNode(folder, prefixId) {
                    const node = document.createElement('div');
                    node.style.marginLeft = folder.parent_id ? '25px' : '0px';
                    node.style.marginTop = '4px';
                    const header = document.createElement('div');
                    header.style.display = 'flex';
                    header.style.alignItems = 'center';
                    header.style.gap = '8px';
                    const hasChildren = folder.subfolders && folder.subfolders.length > 0;
                    const chevronHtml = hasChildren 
                        ? '<i class="fas fa-chevron-right chevron-toggle" style="width:15px; cursor:pointer; color:#94a3b8; text-align:center;" title="Déplier"></i>' 
                        : '<span style="width:15px; display:inline-block;"></span>';
                    header.innerHTML = `
                        ${chevronHtml}
                        <label style="display:flex; align-items:center; gap:8px; cursor:pointer; color:#334155; font-weight:500; margin:0; flex-grow:1;">
                            <input type="checkbox" value="${folder.id}" id="${prefixId}_${folder.id}" style="width:16px; height:16px; cursor:pointer; flex-shrink:0;">
                            <span style="user-select:none;"><i class="far fa-folder" style="color:#1e293b; margin-right:6px;"></i>${folder.name}</span>
                        </label>
                        <select class="folder-size" id="${prefixId}_size_${folder.id}" title="Display size"
                            style="flex-shrink:0; font-size:11px; padding:1px 2px; width:60px; border:1px solid #cbd5e1; border-radius:6px; color:#475569; background:#fff;">
                            <option value="standard">1×1</option>
                            <option value="large">2×1</option>
                            <option value="tall">1×2</option>
                            <option value="hero">Full</option>
                        </select>
                    `;

                    const childrenContainer = document.createElement('div');
                    childrenContainer.style.display = 'none';
                    if (hasChildren) {
                        folder.subfolders.forEach(sub => childrenContainer.appendChild(createTreeNode(sub, prefixId)));
                    }

                    const chevron = header.querySelector('.chevron-toggle');
                    if (chevron) {
                        chevron.addEventListener('click', (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            const isHidden = childrenContainer.style.display === 'none';
                            childrenContainer.style.display = isHidden ? 'block' : 'none';
                            chevron.className = isHidden ? 'fas fa-chevron-down chevron-toggle' : 'fas fa-chevron-right chevron-toggle';
                        });
                    }
                    node.appendChild(header);
                    node.appendChild(childrenContainer);
                    return node;
                }
                Object.values(folderMap).forEach(f => {
                    if (!f.parent_id) {
                        if (checklistNew) checklistNew.appendChild(createTreeNode(f, 'new_f'));
                        if (checklistExisting) checklistExisting.appendChild(createTreeNode(f, 'exist_f'));
                        
                        // populate root trees
                        if (rootTreeContainer) rootTreeContainer.appendChild(createRootFolderTreeNode(f, 'new_f_root', 'new_portal_root_folder'));
                        if (existRootTreeContainer) existRootTreeContainer.appendChild(createRootFolderTreeNode(f, 'exist_f_root', 'existing_portal_root_folder'));
                    }
                });
            }
        })
        .catch(err => console.error("Erreur de chargement des dossiers :", err));
});

// submit du formulaire de creation de portail
document.getElementById('portalForm')?.addEventListener('submit', function(e) {
    e.preventDefault();
    const submitBtn = this.querySelector('.btn-primary-confirm');
    submitBtn.textContent = 'Creating...';
    submitBtn.disabled = true;
    // recup les dossiers cochés dans la création
    const checkedBoxes = document.querySelectorAll('#newPortalFoldersChecklist input[type="checkbox"]:checked');
    const folders = Array.from(checkedBoxes).map(cb => ({
    id: parseInt(cb.value),
    size: document.getElementById(`new_f_size_${cb.value}`)?.value || 'standard'
    }));
    const checkedRadio = document.querySelector('input[name="new_portal_root_folder"]:checked');
    const root_folder_id = checkedRadio ? parseInt(checkedRadio.value) : null;

    const portalData = {
        name: document.getElementById('portalName').value.trim(),
        access: document.getElementById('portalAccess').value || 'Public',
        folders: JSON.stringify(folders),
        root_folder_id: root_folder_id
    };

    fetch('/add_portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(portalData)
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            window.location.reload();
        } 
        else {
            alert('Error: ' + data.message);
            submitBtn.textContent = 'Create Portal';
            submitBtn.disabled = false;
        }
    });
});

let portalToLink_id = null;
// ouvre le modal de liaison rapide de dossier pour un portail
window.prepareLinkFolder = function(portalId, portalName) {
    portalToLink_id = portalId;
    document.getElementById('linkPortalNameText').textContent = portalName;
    document.querySelectorAll('#existingPortalFoldersChecklist input[type="checkbox"]').forEach(cb => cb.checked = false);
    document.querySelectorAll('#existingPortalFoldersChecklist .folder-size').forEach(s => s.value = 'standard');
    fetch(`/portal_folders/${portalId}`)
        .then(res => res.json())
        .then(data => {

            if (data.status === 'success') {
                // reset all existing root folder radio buttons
                document.querySelectorAll('input[name="existing_portal_root_folder"]').forEach(r => {
                    r.checked = false;
                    r.dataset.wasChecked = 'false';
                });
                if (data.root_folder_id) {
                    const radio = document.getElementById(`exist_f_root_root_${data.root_folder_id}`);
                    if (radio) {
                        radio.checked = true;
                        radio.dataset.wasChecked = 'true';
                    }
                }
                if (data.folders) {
                    data.folders.forEach(({ folder_id, display_size }) => {
                        const cb = document.getElementById(`exist_f_${folder_id}`);
                        if (cb) cb.checked = true;
                        const sel = document.getElementById(`exist_f_size_${folder_id}`);
                        if (sel) sel.value = display_size || 'standard';
                    });
                }
            }
            document.getElementById('linkFolderModal').classList.add('active');
        });
};

// save la liste des dossiers cochés
document.getElementById('confirmLinkFolderBtn')?.addEventListener('click', () => {
    if (!portalToLink_id) return;    
    const checkedBoxes = document.querySelectorAll('#existingPortalFoldersChecklist input[type="checkbox"]:checked');
    const folders = Array.from(checkedBoxes).map(cb => ({
        id: parseInt(cb.value),
        size: document.getElementById(`exist_f_size_${cb.value}`)?.value || 'standard'
    }));    
    const checkedRadio = document.querySelector('input[name="existing_portal_root_folder"]:checked');
    const root_folder_id = checkedRadio ? parseInt(checkedRadio.value) : "";
    
    // double-check confirmation pop-ups
    if (folders.length === 0 && !root_folder_id) {
        if (!confirm("You haven't selected any folder or root folder to link to this portal. Are you sure you want to save this portal with no linked folders?")) {
            return;
        }
    } 
    else {
        const portalName = document.getElementById('linkPortalNameText').textContent;
        let msg = `Are you sure you want to save the following assignments for '${portalName}'?`;
        if (root_folder_id) {
            msg += `\n- Root Folder: Selected`;
        }
        if (folders.length > 0) {
            msg += `\n- Folders to display: ${folders.length} selected`;
        }
        if (!confirm(msg)) {
            return;
        }
    }

    const formData = new FormData();
    formData.append('portal_id', portalToLink_id);
    formData.append('folder_ids', JSON.stringify(folders)); 
    formData.append('root_folder_id', root_folder_id);
    const btn = document.getElementById('confirmLinkFolderBtn');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    
    fetch('/link_portal_to_folder', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            document.getElementById('linkFolderModal').classList.remove('active');
            alert("Success! The portal connections have been updated.");
            location.reload();
        } 
        else {
            alert("Error: " + data.message);
            btn.innerHTML = 'Save Link';
        }
    })
    .catch(err => {
        console.error("Error linking folder:", err);
        btn.innerHTML = 'Save Link';
    });
});

document.addEventListener('click', (e) => {
    const radio = e.target.closest('input[type="radio"]');
    if (radio && (radio.name === 'new_portal_root_folder' || radio.name === 'existing_portal_root_folder')) {
        if (radio.dataset.wasChecked === 'true') {
            radio.checked = false;
            radio.dataset.wasChecked = 'false';
        } 
        else {
            document.querySelectorAll(`input[name="${radio.name}"]`).forEach(r => {
                r.dataset.wasChecked = 'false';
            });
            radio.dataset.wasChecked = 'true';
        }
    }
});