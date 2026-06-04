const isAdmin = document.body.getAttribute('data-is-admin') === 'true';
let isListView = false;
let isSortedByDate = false;
let isAuthenticated = false;
const searchInput = document.getElementById("searchInput");
const gallery = document.getElementById("gallery");
const toggleViewBtn = document.getElementById("toggleViewBtn");
const filterSelect = document.getElementById("filterSelect");
const fileCount = document.getElementById("fileCount");
const fileModal = document.getElementById("fileModal");
const closeModal = document.getElementById("closeModal");
const modalPreview = document.getElementById("modalPreview");
const modalTitle = document.getElementById("modalTitle");
const modalDescription = document.getElementById("modalDescription");
const modalTags = document.getElementById("modalTags");
const modalCopyBtn = document.getElementById("modalCopyBtn");
const modalDownloadBtn = document.getElementById("modalDownloadBtn");
const modalAddedDate = document.getElementById("modalAddedDate");
const modalEventDate = document.getElementById("modalEventDate");
const confirmModal = document.getElementById('confirmModal');
const confirmCheckbox = document.getElementById('confirmCheckbox');
const confirmProceed = document.getElementById('confirmProceed');
const confirmCancel = document.getElementById('confirmCancel');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebar = document.getElementById('sidebar');
const mainContent = document.getElementById('mainContent');
const addMainFolderBtn = document.getElementById('addMainFolderBtn');
const foldersContainer = document.getElementById('foldersContainer');
const profileBtn = document.getElementById('profileBtn');
const profileDropdown = document.getElementById('profileDropdown');
const profileLogout = document.getElementById('profileLogout');
let currentDownloadLink = null;
let currentModalFilename = null;
let currentGlobalSort = 'date_desc';
let currentGlobalFilter = 'all';
let currentSectionFilter = 'all';
let currentCategoryFilter = 'all';
let myFavorites = [];
let globalFoldersList = [];


// mappage des types de fichiers
const fileTypeMap = {
  images: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp'],
  videos: ['.mp4', '.mov', '.avi', '.wmv', '.flv', '.mkv', '.webm'],
  audio: ['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a'],
  documents: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.rtf', '.odt'],
  presentations: ['.ppt', '.pptx', '.key', '.odp']
};

function getFileExtension(filename) {
  return filename.slice(filename.lastIndexOf('.')).toLowerCase();
}

document.querySelectorAll('.sort-dropdown-content button[data-sort]').forEach(button => {
    button.addEventListener('click', (e) => {
        currentGlobalSort = e.currentTarget.getAttribute('data-sort');
        const textCloned = e.currentTarget.textContent.trim();
        document.getElementById('sortDropdownBtn').innerHTML = `<i class="fas fa-sort"></i> Sort: ${textCloned}`;
        executeGlobalSearch(currentSearchQuery, 1);
    });
});

document.querySelectorAll('.filter-dropdown-content button[data-filter]').forEach(button => {
    button.addEventListener('click', (e) => {
        currentGlobalFilter = e.currentTarget.getAttribute('data-filter');
        const textCloned = e.currentTarget.textContent.trim();
        document.getElementById('filterDropdownBtn').innerHTML = `<i class="fas fa-filter"></i> ${textCloned}`;
        executeGlobalSearch(currentSearchQuery, 1);
    });
});

function formatDateForDisplay(dateString) {
  if (!dateString) return "No date";
  
  if (/^\d{2}-\d{2}-\d{4}$/.test(dateString)) {
    return dateString;
  }
  
  try {
    const [day, month, year] = dateString.split('-');
    return `${day}-${month}-${year}`;
  } catch (e) {
    console.error("Error formatting date:", e);
    return "Invalid date";
  }
}

// dossiers
function loadFolders(folderIdToRestore = null) {
  fetch('/get_folders')
    .then(response => response.json())
    .then(data => {
      globalFoldersList = data.folders || [];
      renderFolderStructure(data.folders);
      const targetId = folderIdToRestore || currentFolderFilter;
      if (targetId) {
          setTimeout(() => {
              if (typeof window.triggerFolderClick === 'function') {
                  window.triggerFolderClick(targetId);
              }
          }, 50);
      }
    })
    .catch(error => console.error('Error loading folders:', error));
}

function renderFolderStructure(folders) {
  foldersContainer.innerHTML = '';
  
  const folderMap = {};
  folders.forEach(folder => {
    folderMap[folder.id] = {
      ...folder,
      element: null,
      subfolders: []
    };
  });
  
  // hiérarchie pour doss
  Object.values(folderMap).forEach(folder => {
    if (folder.parent_id && folderMap[folder.parent_id]) {
      folderMap[folder.parent_id].subfolders.push(folder);
    }
  });
  
  // dossiers racine
  Object.values(folderMap).forEach(folder => {
    if (!folder.parent_id) {
      renderFolder(folder, foldersContainer);
    }
  });
}

function renderFolder(folder, parentElement) {
  const folderElement = document.createElement('div');
  folderElement.className = 'folder';
  folderElement.dataset.folderId = folder.id;
  const folderName = document.createElement('div');
  folderName.className = 'folder-name';
  folderName.style.display = 'flex';
  folderName.style.justifyContent = 'space-between';
  folderName.style.alignItems = 'center';
  const iconHtml = folder.subfolders && folder.subfolders.length > 0 
    ? '<i class="far fa-folder" style="color: #1e293b; font-size: 16px; margin-right: 8px;"></i>' 
    : '<i class="far fa-folder" style="color: #64748b; font-size: 15px; margin-right: 8px; opacity: 0.7;"></i>';
  const adminButtons = isAdmin ? `
        <button class="add-folder-btn" title="Add subfolder" style="background: none; border: none; color: #16677c; cursor: pointer; padding: 2px 4px;">
            <i class="fas fa-plus"></i>
        </button>
        <button class="delete-folder-btn" title="Delete folder" style="background: none; border: none; color: #ef4444; cursor: pointer; padding: 2px 4px;">
            <i class="fas fa-times"></i>
        </button>
  ` : ''; 
  const renameAction = isAdmin ? `ondblclick="renameFolder(this, ${folder.id})" title="Double-click to rename" style="cursor: text;"` : '';
  
  folderName.innerHTML = `
    <div style="display: flex; align-items: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-grow: 1;">
        <span class="folder-icon">${iconHtml}</span>
        <span class="folder-title" style="font-weight: 500; color: #334155; flex-grow: 1;" ${renameAction}>${folder.name}</span>
    </div>
    
    <div class="folder-actions-wrapper">
        <button class="action-dropdown-btn" style="background:none; border:none; color:#94a3b8; cursor:pointer; padding:2px 8px;">
            <i class="fas fa-ellipsis-v"></i>
        </button>
        
        <div class="folder-actions">
            <button class="download-folder-btn" title="Download folder as ZIP" style="background: none; border: none; color: #10b981; cursor: pointer; padding: 4px;">
                <i class="fas fa-file-archive"></i>
            </button>
            ${adminButtons}
        </div>
    </div>
  `;

  const subfolders = document.createElement('div');
  subfolders.className = 'subfolders';
  subfolders.style.display = 'none';
  folderElement.appendChild(folderName);
  folderElement.appendChild(subfolders);
  
  if (folder.subfolders) {
      folder.subfolders.forEach(subfolder => {
        renderFolder(subfolder, subfolders);
      });
  }

  folderName.addEventListener('click', function(e) {
    if (e.target.closest('.download-folder-btn')) { 
      e.stopPropagation();
      downloadFolderAsZip(folder.id, e.target.closest('.download-folder-btn'));
      return;
    }
    if (e.target.closest('.add-folder-btn')) {
      e.stopPropagation();
      if (isAdmin) showFolderInput(subfolders, folder.id);
      return;
    }
    if (e.target.closest('.delete-folder-btn')) {
      e.stopPropagation();
      if (isAdmin && confirm('Delete this folder?')) deleteFolder(folder.id);
      return;
    }
    document.querySelectorAll('.folder-name').forEach(el => el.classList.remove('is-selected'));
    folderElement.classList.toggle('active');
    if (folderElement.classList.contains('active')) {
        folderName.classList.add('is-selected');
        subfolders.style.display = 'block';
        currentFolderFilter = folder.id;
    } 
    else {
        currentFolderFilter = null;
        subfolders.style.display = 'none';

        folderElement.querySelectorAll('.folder.active').forEach(child => {
            child.classList.remove('active');
            const childSub = child.querySelector(':scope > .subfolders');
            if (childSub) childSub.style.display = 'none';
        });
    }
    const siblings = folderElement.parentNode.querySelectorAll(':scope > .folder');
    siblings.forEach(sibling => {
        if (sibling !== folderElement) sibling.classList.remove('active');
    });
    updateBreadcrumbs(currentFolderFilter);
    gallery.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 50px; color: var(--gray-500);">
            <i class="fas fa-spinner fa-spin fa-2x" style="margin-bottom: 15px;"></i>
            <p style="font-family: 'Plus Jakarta Sans'; font-weight: 600;">Filtrage...</p>
        </div>`;
    executeGlobalSearch(currentSearchQuery, 1);
  });
  
  parentElement.appendChild(folderElement);
  folder.element = folderElement;
}

function showFolderInput(parentElement, parentId = null) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'folder-input';
  input.placeholder = 'Enter folder name';
  let isHandled = false; 
  input.addEventListener('keyup', function(e) {
    if (e.key === 'Enter' && this.value.trim() && !isHandled) {
      isHandled = true; 
      createFolder(this.value.trim(), parentId);
      if (this.parentNode) this.remove();
    } 
    else if (e.key === 'Escape' && !isHandled) {
      isHandled = true; 
      if (this.parentNode) this.remove();
    }
  });
  input.addEventListener('blur', function() {
    if (!isHandled) {
      isHandled = true; 
      if (this.parentNode) this.remove();
    }
  });
  parentElement.appendChild(input);
  input.focus();
}

function createFolder(name, parentId = null) {
  const formData = new FormData();
  formData.append('name', name);
  if (parentId) formData.append('parent_id', parentId);
  fetch('/create_folder', {
    method: 'POST',
    body: formData
  })
  .then(response => response.json())
  .then(data => {
    if (data.status === 'success') {
      loadFolders(parentId);
    } 
    else {
      alert('Error creating folder: ' + data.message);
    }
  })
  .catch(error => console.error('Error creating folder:', error));
}

function deleteFolder(folderId) {
  const formData = new FormData();
  formData.append('folder_id', folderId);
  
  fetch('/delete_folder', {
    method: 'POST',
    body: formData
  })
  .then(response => response.json())
  .then(data => {
    if (data.status === 'success') {
      loadFolders();
      filterAndDisplay();
    } 
    else {
      alert('Error deleting folder: ' + data.message);
    }
  })
  .catch(error => console.error('Error deleting folder:', error));
}

// fonction rename dossier double clic
function renameFolder(element, folderId) {
    if (element.querySelector('input')) return;
    const currentName = element.textContent.trim();    
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentName;    
    input.style.width = "100%";
    input.style.padding = "2px 5px";
    input.style.border = "1px solid #0078d4";
    input.style.borderRadius = "4px";
    input.style.fontFamily = "inherit";
    input.style.fontSize = "inherit";
    element.textContent = '';
    element.appendChild(input);
    input.focus();
    input.select();
    const saveRename = async () => {
        const newName = input.value.trim();        
        if (!newName || newName === currentName) {
            element.textContent = currentName;
            return;
        }

        element.textContent = "...";
        const formData = new FormData();
        formData.append('folder_id', folderId);
        formData.append('new_name', newName);
        try {
            const response = await fetch('/rename_folder', {
                method: 'POST',
                body: formData
            });
            const result = await response.json();
            if (result.status === 'success') {
                element.textContent = result.new_name;
            } 
            else {
                alert("Erreur : " + result.message);
                element.textContent = currentName;
            }
        } catch (error) {
            alert("Erreur de connexion.");
            element.textContent = currentName;
        }
    };

    input.addEventListener('blur', saveRename); 
    input.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            input.blur(); 
        }
    });
}

function createHeaderBubbles() {
  const header = document.querySelector('header');
  const bubblesContainer = document.createElement('div');
  bubblesContainer.className = 'header-bubbles';
  bubblesContainer.id = 'headerBubbles';
  
  header.appendChild(bubblesContainer);
  
  const bubbleCount = 15;
  
  for (let i = 0; i < bubbleCount; i++) {
    createBubble(bubblesContainer);
  }
}

function createBubble(container) {
  const bubble = document.createElement('div');
  bubble.classList.add('bubble');
  const size = Math.random() * 40 + 20;
  bubble.style.width = `${size}px`;
  bubble.style.height = `${size}px`;
  const posX = Math.random() * 100;
  const posY = Math.random() * 100;
  bubble.style.left = `${posX}%`;
  bubble.style.top = `${posY}%`;
  const delay = Math.random() * 5;
  bubble.style.animationDelay = `${delay}s`;
  const duration = 8 + Math.random() * 4;
  bubble.style.animationDuration = `${duration}s`;
  container.appendChild(bubble);
  setTimeout(() => {
    bubble.remove();
    createBubble(container);
  }, (duration + delay) * 1000);
}

function filterFilesByFolder(folderId) {
  // récupérer tous les fichiers dans ce dossier et ses sous dossiers
  fetch(`/get_files_in_folder/${folderId}`)
    .then(response => response.json())
    .then(data => {
      const filesInFolder = data.files.map(f => f.name.toLowerCase());
      // maintenant filtrer l'affichage
      const items = gallery.querySelectorAll(".gallery-item");
      items.forEach(item => {
        const itemName = item.getAttribute("data-name").toLowerCase();
        item.style.display = filesInFolder.includes(itemName) ? "block" : "none";
      });
      
      fileCount.textContent = `Showing ${filesInFolder.length} files in folder`;
    })
    .catch(error => {
      console.error('Error filtering files:', error);
    });
}

function updateFileFolder(filename, folderId) {
  // On utilise URLSearchParams au lieu de FormData pour que le serveur Node.js puisse le lire nativement
  const params = new URLSearchParams();
  params.append('filename', filename);
  if (folderId) params.append('folder_id', folderId);
  
  fetch('/update_file_folder', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params
  })
  .then(response => response.json())
  .then(data => {
    if (data.status === 'success') {
      const item = document.querySelector(`.gallery-item[data-filename="${filename}"]`);
      if (item) {
        item.dataset.folderId = folderId || '';
      }
    } else {
      alert('Error updating folder: ' + data.message);
    }
  })
  .catch(error => console.error('Error:', error));
}

// gestion files
function filterAndDisplay() {
  const currentFilter = document.querySelector('.filter-dropdown-content button[data-filter]')?.getAttribute('data-filter') || 'all';
  filterAndDisplayWithFilter(currentFilter);
}

function sortGallery(asc = true) {
  const items = Array.from(gallery.children).filter(item => item.classList.contains('gallery-item'));
  items.sort((a, b) => {
    const nameA = a.getAttribute("data-name");
    const nameB = b.getAttribute("data-name");
    return asc ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA);
  });
  
  items.forEach(item => gallery.appendChild(item));
  filterAndDisplay();
}

function groupFilesByDate() {
  const gallery = document.getElementById("gallery");
  const items = Array.from(gallery.querySelectorAll(".gallery-item"));
  
  const filesByDate = {};
  
  items.forEach(item => {
    const date = item.getAttribute("data-date");
    if (!date) return;
    
    if (!/^\d{2}-\d{2}-\d{4}$/.test(date)) {
      console.warn("Invalid date format:", date);
      return;
    }
    
    if (!filesByDate[date]) {
      filesByDate[date] = [];
    }
    filesByDate[date].push(item);
  });
  
  const sortedDates = Object.keys(filesByDate).sort((a, b) => {
    const [dayA, monthA, yearA] = a.split('-').map(Number);
    const [dayB, monthB, yearB] = b.split('-').map(Number);
    const dateA = new Date(yearA, monthA - 1, dayA);
    const dateB = new Date(yearB, monthB - 1, dayB);
    return dateB - dateA;
  });
  
  gallery.innerHTML = '';
  
  sortedDates.forEach(date => {
    const dateHeader = document.createElement("div");
    dateHeader.className = "date-group";
    dateHeader.textContent = date;
    gallery.appendChild(dateHeader);
    
    filesByDate[date].forEach(item => {
      gallery.appendChild(item);
    });
  });
}

function lazyLoadImages() {
  const lazyImages = document.querySelectorAll('img[loading="lazy"]');
  
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        const placeholder = img.previousElementSibling;
        
        img.onload = function() {
          img.setAttribute('data-loaded', 'true');
          if (placeholder && placeholder.classList.contains('img-placeholder')) {
            placeholder.style.display = 'none';
          }
        };
        
        if (!img.src || img.src !== img.dataset.src) {
          img.src = img.dataset.src || img.getAttribute('src');
        }
        
        observer.unobserve(img);
      }
    });
  }, {
    rootMargin: '50px 0px',
    threshold: 0.01
  });

  lazyImages.forEach(img => {
    if (!img.dataset.src) {
      img.dataset.src = img.getAttribute('src');
      img.removeAttribute('src');
    }
    observer.observe(img);
  });
}

// modal
function showFileModal(item) {
  currentModalFilename = item.getAttribute('data-filename');
  const filename = currentModalFilename;
  const link = item.getAttribute('data-link');
  const ext = getFileExtension(filename); 
  const folderNameFromCard = item.getAttribute('data-folder-name') || 'None';
  const portalNameFromCard = item.getAttribute('data-portal-name') || 'None';
  
  const folderNameSpan = document.getElementById('currentFolderName');
  if (folderNameSpan) folderNameSpan.textContent = folderNameFromCard;
  const portalNameSpan = document.getElementById('currentPortalName');
  if (portalNameSpan) portalNameSpan.textContent = portalNameFromCard;
  
  const btnAddPortal = document.getElementById('addToPortalBtn');
  const btnRemovePortal = document.getElementById('removeFromPortalBtn');

  if (portalNameFromCard !== 'None' && portalNameFromCard !== '') {
      if (btnAddPortal) {
          btnAddPortal.textContent = 'Change Portal';
          btnAddPortal.style.display = 'block';
      }
      if (btnRemovePortal) btnRemovePortal.style.display = 'block'; 
  } 
  else {
      if (btnAddPortal) {
          btnAddPortal.textContent = 'Assign to Portal';
          btnAddPortal.style.display = 'block';
      }
      if (btnRemovePortal) btnRemovePortal.style.display = 'none'; 
  }
  
  const modalTitle = document.getElementById('modalTitle');
  const modalDownloadBtn = document.getElementById('modalDownloadBtn');
  const modalDescription = document.getElementById('modalDescription');
  const modalAddedDate = document.getElementById('modalAddedDate');
  const modalEventDate = document.getElementById('modalEventDate');
  const modalTags = document.getElementById('modalTags');
  const modalPreview = document.getElementById('modalPreview');
  const fileModal = document.getElementById('fileModal');
  const modalSection = document.getElementById('modalSection');
  const modalCategory = document.getElementById('modalCategory');
  const modalFavBtn = document.getElementById('modalFavoriteBtn');
  
  if (modalFavBtn) {
      const isFav = myFavorites.includes(filename);
      modalFavBtn.classList.toggle('is-favorited', isFav);
      modalFavBtn.querySelector('i').className = isFav ? 'fas fa-heart' : 'far fa-heart';
  }
  if (modalTitle) modalTitle.textContent = filename;
  if (modalDownloadBtn) modalDownloadBtn.href = `/download?url=${encodeURIComponent(link)}&filename=${filename}`;
  
  fetch(`/file_details?filename=${encodeURIComponent(filename)}`)
    .then(response => response.json())
    .then(data => {
      const descriptionHTML = data.description 
          ? `<p>${data.description}</p>`
          : "<p>No description available</p>";
      if (modalDescription) modalDescription.innerHTML = descriptionHTML;
      if (modalAddedDate) modalAddedDate.textContent = data.date_ajout || "Unknown";
      if (modalEventDate) modalEventDate.textContent = data.date_event || "Not specified";
      if (modalSection) modalSection.textContent = data.section || "None";
      if (modalCategory) modalCategory.textContent = data.category || "None";

      if (modalTags) {
          modalTags.innerHTML = ''; 
          if (data.tags && data.tags.length > 0) {
              data.tags.forEach(tag => {
                  const tagText = tag.trim();
                  const tagSpan = document.createElement('span');
                  tagSpan.className = 'modal-tag';
                  tagSpan.textContent = tagText;
                  tagSpan.style.cursor = 'pointer';
                  tagSpan.style.transition = 'opacity 0.2s';
                  tagSpan.onmouseover = () => { tagSpan.style.opacity = '0.7'; };
                  tagSpan.onmouseout = () => { tagSpan.style.opacity = '1'; };
                  tagSpan.addEventListener('click', () => {
                      if (fileModal) {
                          fileModal.classList.remove('active');
                          document.body.style.overflow = 'auto'; 
                      }
                      const searchInput = document.getElementById('searchInput');
                      if (searchInput) {
                          searchInput.value = tagText;
                          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                      }
                  });
                  modalTags.appendChild(tagSpan);
              });
          } else {
              modalTags.innerHTML = "<span class='modal-tag'>No tags</span>";
          }
      }      
      
      if (typeof updateFolderButtons === 'function') updateFolderButtons(!!data.folder_id);
      if (typeof loadFoldersForModal === 'function') loadFoldersForModal(data.folder_id);
      if (typeof loadPortalsForModal === 'function') loadPortalsForModal(data.portal_id);
    })
    .catch(error => {
      console.error('Error fetching file details:', error);
    });
    
  let previewContent = '';
  if (fileTypeMap.images.includes(ext)) {
      previewContent = `<img src="${link}" alt="${filename}" style="max-width:100%; max-height:80vh; object-fit:contain;" />`;
  } else if (fileTypeMap.videos.includes(ext)) {
      previewContent = `<video controls autoplay style="width:100%; max-height:80vh;"><source src="${link}" type="video/${ext.slice(1)}"></video>`;
  } else if (fileTypeMap.audio.includes(ext)) {
      previewContent = `<audio controls autoplay style="width:100%;"><source src="${link}" type="audio/${ext.slice(1)}"></audio>`;
  } else if (ext === '.pdf') {
      previewContent = `<iframe src="${link}" width="100%" height="100%" style="border:none;"></iframe>`;
  } else if (['.docx', '.pptx'].includes(ext)) {
      previewContent = `<iframe src="https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(link)}" width="100%" height="100%" style="border:none;"></iframe>`;
  } else {
      previewContent = `<div class="file-preview" style="width:100%; height:100%; display:flex; flex-direction:column; justify-content:center; align-items:center;"><div style="font-size:24px; margin-bottom:10px;">${ext.toUpperCase()}</div><div>Preview not available</div></div>`;
  }
  
  if (modalPreview) modalPreview.innerHTML = previewContent;  
  if (fileModal) {
      fileModal.classList.add('active');
      document.body.style.overflow = 'hidden';
  }
}

function loadFoldersForModal(currentFolderId) {
  fetch('/get_folders')
    .then(response => response.json())
    .then(data => {
      if (currentFolderId) {
        const currentFolder = data.folders.find(f => f.id == currentFolderId);
        document.getElementById('currentFolderName').textContent = currentFolder 
            ? currentFolder.name 
            : "Unknown";
      } 
      else {
        document.getElementById('currentFolderName').textContent = "None";
      }
      if (typeof updateFolderButtons === 'function') updateFolderButtons(!!currentFolderId);
      const folderTree = document.getElementById('folderTree');
      if (!folderTree) return; 
      folderTree.innerHTML = '';
      const folderMap = {};
      data.folders.forEach(folder => {
        folderMap[folder.id] = { ...folder, element: null, subfolders: [] };
      });
      Object.values(folderMap).forEach(folder => {
        if (folder.parent_id && folderMap[folder.parent_id]) {
          folderMap[folder.parent_id].subfolders.push(folder);
        }
      });
      Object.values(folderMap).forEach(folder => {
        if (!folder.parent_id) {
          renderFolderNode(folder, folderTree, currentFolderId);
        }
      });
    })
    .catch(error => console.error('Error loading folders:', error));
    
}
/*
// assigner au portail
    const btnAddPortal = document.getElementById('addToPortalBtn');
    const portalList = document.getElementById('portalList');
    if (portalNameFromCard !== 'None' && portalNameFromCard !== '') {
        if (btnAddPortal) {
            btnAddPortal.textContent = 'Change Portal';
            btnAddPortal.style.display = 'block';
        }
        if (btnRemovePortal) btnRemovePortal.style.display = 'block'; 
    } 
    else {
        if (btnAddPortal) {
            btnAddPortal.textContent = 'Assign to Portal';
            btnAddPortal.style.display = 'block';
        }
        if (btnRemovePortal) btnRemovePortal.style.display = 'none'; 
    }
    if (btnAddPortal && portalList) {
        const newBtnAddPortal = btnAddPortal.cloneNode(true);
        btnAddPortal.parentNode.replaceChild(newBtnAddPortal, btnAddPortal);

        newBtnAddPortal.addEventListener('click', function(e) {
            e.preventDefault();
            if (portalList.style.display === 'none' || portalList.style.display === '') {
                portalList.innerHTML = '<span style="font-size:12px; color:var(--gray-500);">Chargement des portails...</span>';
                portalList.style.display = 'block';

                fetch('/get_all_portals')
                .then(response => response.json())
                .then(data => {
                    portalList.innerHTML = '';
                    if(data.portals && data.portals.length > 0) {
                        data.portals.forEach(portal => {
                            const btn = document.createElement('button');
                            btn.className = 'modern-btn secondary-btn';
                            btn.style.width = '100%';
                            btn.style.marginBottom = '6px';
                            btn.style.textAlign = 'left';
                            btn.innerHTML = `${portal.name}`;
                            btn.onclick = () => window.addFileToPortal(portal.id, portal.name);
                            portalList.appendChild(btn);
                        });
                    } 
                    else {
                        portalList.innerHTML = '<span style="font-size:12px;">Aucun portail trouvé.</span>';
                    }
                })
                .catch(err => {
                    console.error("Erreur Fetch Portails :", err);
                    portalList.innerHTML = '<span style="color:red; font-size:12px;">Erreur de chargement</span>';
                });
            } 
            else {
                portalList.style.display = 'none';
            }
        });
    }
*/

const btnRemoveFolder = document.getElementById('removeFromFolderBtn');
if (btnRemoveFolder) {
    btnRemoveFolder.addEventListener('click', function() {
        if (isAdmin) {
            removeFileFromFolder(currentModalFilename);
        } 
        else {
            alert("You don't have permission to perform this action. Only administrators can modify folders.");
        }
    });
}

function renderFolderNode(folder, parentElement, currentFolderId) {
  const folderElement = document.createElement('div');
  folderElement.className = 'folder-node';
  folderElement.dataset.folderId = folder.id;
  const folderHeader = document.createElement('div');
  folderHeader.className = 'folder-header';
  const iconHtml = folder.subfolders && folder.subfolders.length > 0 
    ? '<i class="far fa-folder" style="color: #1e293b; font-size: 16px;"></i>' 
    : '<i class="far fa-folder" style="color: #64748b; font-size: 15px; opacity: 0.7;"></i>';

  folderHeader.innerHTML = `
    <span class="folder-icon" style="margin-right: 10px;">${iconHtml}</span>
    <span class="folder-title" style="font-weight: 500; color: #334155; flex-grow: 1;">${folder.name}</span>
    <button class="select-folder-btn" title="Select this folder" style="background: none; border: none; color: #16a34a; cursor: pointer;">
        <i class="fas fa-check"></i>
    </button>
  `;
  
  const subfoldersContainer = document.createElement('div');
  subfoldersContainer.className = 'subfolders-container';
  subfoldersContainer.style.display = 'none';
  folderElement.appendChild(folderHeader);
  folderElement.appendChild(subfoldersContainer);
  if (folder.subfolders) {
      folder.subfolders.forEach(subfolder => {
        renderFolderNode(subfolder, subfoldersContainer, currentFolderId);
      });
  }
  
  folderHeader.addEventListener('click', function(e) {
    if (e.target.closest('.select-folder-btn')) {
      e.stopPropagation();
      updateFileFolder(currentModalFilename, folder.id);
      document.getElementById('currentFolderName').textContent = folder.name;
      document.getElementById('folderTree').style.display = 'none';
      return;
    }
    folderElement.classList.toggle('active');
    if (folderElement.classList.contains('active')) {
        subfoldersContainer.style.display = 'block';
    } 
    else {
        subfoldersContainer.style.display = 'none';
        folderElement.querySelectorAll('.folder-node.active').forEach(child => {
            child.classList.remove('active');
            const childSub = child.querySelector(':scope > .subfolders-container');
            if (childSub) childSub.style.display = 'none';
        });
    }
  });
  
  parentElement.appendChild(folderElement);
}

function closeFileModal() {
  fileModal.classList.remove('active');
  document.body.style.overflow = '';
  const videos = modalPreview.querySelectorAll('video');
  const audios = modalPreview.querySelectorAll('audio');
  videos.forEach(video => {
    video.pause();
    video.currentTime = 0;
  });
  audios.forEach(audio => {
    audio.pause();
    audio.currentTime = 0;
  });
}

function filterAndDisplayWithFilter(filterValue) {
  let visibleCount = 0;
  const items = gallery.querySelectorAll(".gallery-item");
  items.forEach(item => {
    const name = item.getAttribute("data-name").toLowerCase();
    const ext = getFileExtension(name);
    const isExclusive = item.getAttribute("data-exclusive") === 'true';
    let show = true; 
    if (filterValue === 'all') {
      show = true;
    } else if (filterValue === 'exclusive') {
      show = isExclusive === true || isExclusive === 'true';
    } else if (filterValue === 'others') {
      const allExts = [].concat(...Object.values(fileTypeMap));
      show = !allExts.includes(ext);
    } else {
      show = fileTypeMap[filterValue]?.includes(ext) || false;
    }
    item.style.display = show ? "block" : "none";
    if (show) visibleCount++;
  });
  const realTotal = fileCount.getAttribute('data-total');
  if(fileCount) fileCount.textContent = `Showing ${visibleCount} of ${realTotal} files`;  
  lazyLoadImages();
}

// recherche global
const pagination = document.querySelector('.pagination');
let typingTimer;                
const doneTypingInterval = 400;  
let currentSearchQuery = ""; 
if (searchInput) {
    searchInput.addEventListener('input', function() {
        clearTimeout(typingTimer);
        const query = searchInput.value.trim();

        if (query.length > 0) {
            currentSearchQuery = query;
            typingTimer = setTimeout(() => executeGlobalSearch(query, 1), doneTypingInterval);
        } 
        else {
            window.location.href = window.location.pathname; 
        }
    });
}


let currentFolderFilter = null;
function executeGlobalSearch(query, page = 1) {
    gallery.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 50px; color: var(--gray-500);">
            <i class="fas fa-spinner fa-spin fa-2x" style="margin-bottom: 15px;"></i>
            <p style="font-family: 'Plus Jakarta Sans'; font-weight: 600;">Chargement...</p>
        </div>`;
        let url = `/search_file?filename=${encodeURIComponent(query)}&page=${page}&per_page=100&sort=${currentGlobalSort}&filter=${currentGlobalFilter}&section=${currentSectionFilter}&category=${currentCategoryFilter}`;
        if (currentFolderFilter) {
          url += `&folder_id=${currentFolderFilter}`;
        }
    fetch(url) 
        .then(response => response.json())
        .then(data => {
            gallery.innerHTML = ''; 
            if ((!query || query.trim() === '') && currentFolderFilter) {
                let subfoldersToShow = globalFoldersList.filter(f => f.parent_id == currentFolderFilter);
                subfoldersToShow.sort((a, b) => {
                    const dateA = a.creation_date ? new Date(a.creation_date) : new Date(0);
                    const dateB = b.creation_date ? new Date(b.creation_date) : new Date(0);
                    return dateB - dateA; 
                });
                subfoldersToShow.forEach(subfolder => {
                    let dateText = 'No date';
                    if (subfolder.creation_date) {
                        const d = new Date(subfolder.creation_date);
                        dateText = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth()+1).padStart(2, '0')}-${d.getFullYear()}`;
                    }
                    const folderCardHtml = `
                        <div class="gallery-item folder-card" data-folder-id="${subfolder.id}" style="cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: space-between; background: #ffffff; border: 1px solid #cbd5e1; box-shadow: 0 2px 4px rgba(0,0,0,0.05); height: 100%;">
                            <div style="width: 100%; text-align: left; padding: 10px 15px; font-size: 11px; color: #64748b; font-weight: 600; border-bottom: 1px solid #f1f5f9;">
                                <i class="fas fa-calendar-alt" style="margin-right: 5px;"></i> ${dateText}
                            </div>
                            <div style="flex-grow: 1; display: flex; align-items: center; justify-content: center; width: 100%; padding: 20px 0;">
                                <i class="far fa-folder" style="font-size: 65px; color: #1e293b;"></i>
                            </div>
                            <div class="image-title" style="background: #94a3b8; color: white; width: 100%; text-align: center; padding: 12px 0; font-weight: 600; font-size: 14px; border-radius: 0 0 11px 11px;">
                                ${subfolder.name}
                            </div>
                        </div>`;
                    gallery.insertAdjacentHTML('beforeend', folderCardHtml);
                });
            }
            const files = data.files;
            const total = data.total;
            const totalPages = data.total_pages;
            if(fileCount) fileCount.innerHTML = `${total} results found`;
            if (files.length === 0) {
                gallery.innerHTML = `
                    <div style="grid-column: 1 / -1; text-align: center; padding: 50px; color: var(--gray-500);">
                        <i class="fas fa-search-minus fa-2x" style="margin-bottom: 15px; color: #cbd5e1;"></i>
                        <p style="font-family: 'Plus Jakarta Sans'; font-weight: 600;">This folder is empty.</p>
                    </div>`;
                if (pagination) pagination.style.display = 'none';
                return;
            }
            let currentDateGroup = null; 

            files.forEach(file => {
                const ext = file.name.split('.').pop().toLowerCase();
                let mediaHtml = '';
                
                if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
                    mediaHtml = `<div class="img-placeholder"></div><img src="${file.url}" alt="${file.name}" loading="lazy" />`;
                } 
                else if (['mp4', 'webm', 'mov'].includes(ext)) {
                    mediaHtml = `<video controls width="100%" style="max-height: 200px; border-radius: 11px 11px 0 0; object-fit: cover;" preload="none"><source src="${file.url}" type="video/${ext}"></video>`;
                } 
                else if (ext === 'pdf') {
                    mediaHtml = `<iframe src="${file.url}" width="100%" height="200px" style="border: 1px solid #e2e8f0; border-radius: 11px 11px 0 0;" loading="lazy" preload="none"></iframe>`;
                }
                else if (['docx', 'pptx'].includes(ext)) {
                    mediaHtml = `<iframe src="https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(file.url)}" width="100%" height="200px" style="border: none;" loading="lazy" preload="none"></iframe>`;
                }
                else if (['emf', 'heic', 'thm', 'psd'].includes(ext)) {
                    mediaHtml = `<img src="/static/icons/${ext}.png" alt="${file.name}" style="max-height: 200px; object-fit: contain;" loading="lazy" />`;
                } 
                else {
                    mediaHtml = `<div class="file-preview"><img src="/static/No_preview.png" style="max-width:80px;"/><div style="font-weight: 700; color: var(--gray-500);">${ext.toUpperCase()}</div></div>`;
                }

                if (currentGlobalSort === 'date_desc') {
                    const fileDate = file.date_ajout || 'Old files (undated)';
                    if (fileDate !== currentDateGroup) {
                        currentDateGroup = fileDate;
                        const dateHeaderHtml = `
                            <div class="date-group-header" style="grid-column: 1 / -1; font-size: 22px; font-weight: 800; color: #16677c; margin-top: 30px; margin-bottom: 10px; border-bottom: 2px solid #e2e8f0; padding-bottom: 5px; width: 100%;">
                                ${fileDate}
                            </div>`;
                        gallery.insertAdjacentHTML('beforeend', dateHeaderHtml);
                    }
                }

                const isExclusive = file.is_exclusive === true || file.is_exclusive === 'true';
                const isFavorited = myFavorites.includes(file.name);
                const cardHtml = `
                    <div class="gallery-item" 
                         data-name="${file.name.toLowerCase()}" 
                         data-link="${file.url}" 
                         data-filename="${file.name}" 
                         data-description="${file.description || ''}" 
                         data-tags='${JSON.stringify(file.tags || [])}' 
                         data-exclusive="${isExclusive ? 'true' : 'false'}" 
                         data-date="${file.date_ajout || ''}">
                         <div class="select-checkbox"><i class="fas fa-check"></i></div>
                        ${mediaHtml}
                        <div class="image-title" title="${file.name}">${file.name}</div>
                        <div class="item-footer">
                            <button class="favorite-btn ${isFavorited ? 'is-favorited' : ''}" 
                                    onclick="toggleFavorite(event, '${file.name}')">
                                <span class="tooltip">${isFavorited ? 'Remove from favorites' : 'Add to favorites'}</span>
                                <i class="${isFavorited ? 'fas' : 'far'} fa-heart"></i>
                            </button>
                            <button class="copy-link-btn" data-link="${file.url}"><span class="tooltip">Copy Link</span><i class="fas fa-link"></i></button>
                            <a href="${file.url}" class="download-btn" download="${file.name}"><span class="tooltip">Download</span><i class="fas fa-download"></i></a>
                            <button class="exclusive-btn ${isExclusive ? 'exclusive' : ''}" data-filename="${file.name}"><span class="tooltip">${isExclusive ? 'Exclusive' : 'Not Exclusive'}</span><i class="${isExclusive ? 'fas fa-star' : 'far fa-star'}"></i></button>
                        </div>
                    </div>`;
                gallery.insertAdjacentHTML('beforeend', cardHtml);
            });
            renderSearchPagination(query, page, totalPages);
            if (typeof lazyLoadImages === 'function') lazyLoadImages();
            if (typeof setupGalleryItemClicks === 'function') setupGalleryItemClicks();
            if (typeof setupCopyLinkButtons === 'function') setupCopyLinkButtons();
        })
        .catch(error => {
            console.error('Error', error);
            gallery.innerHTML = `
                <div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; margin-top: 20px;">
                    <i class="fas fa-hourglass-end fa-3x" style="color: #ef4444; margin-bottom: 20px;"></i>
                    <h3 style="font-family: 'Plus Jakarta Sans'; color: #1e293b; margin-bottom: 10px; font-weight: 700;">Session expirée</h3>
                    <p style="color: #64748b; margin-bottom: 25px; font-size: 14px;">Votre session est inactive depuis un moment. La page va se rafraîchir automatiquement pour vous reconnecter.</p>
                    <button onclick="window.location.reload()" class="modern-btn primary-btn" style="margin: 0 auto; display: inline-flex;">
                        <i class="fas fa-sync-alt fa-spin" style="margin-right: 8px;"></i> Reconnexion en cours...
                    </button>
                </div>`;
            setTimeout(() => {
                window.location.reload();
            }, 2500);
        });
}

// recréer les boutons de pagination
function renderSearchPagination(query, currentPage, totalPages) {
    if (!pagination) return;
    if (totalPages <= 1) {
        pagination.style.display = 'none';
        return;
    }
    pagination.style.display = 'flex';
    pagination.innerHTML = '';
    const prevBtn = document.createElement('button');
    prevBtn.className = `page-btn ${currentPage === 1 ? 'disabled' : ''}`;
    prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i> Prev';
    if (currentPage > 1) {
        prevBtn.onclick = () => executeGlobalSearch(query, currentPage - 1);
    }
    pagination.appendChild(prevBtn);
    const indicator = document.createElement('span');
    indicator.className = 'page-btn active';
    indicator.style.cursor = 'default';
    indicator.textContent = `Page ${currentPage} of ${totalPages}`;
    pagination.appendChild(indicator);
    const nextBtn = document.createElement('button');
    nextBtn.className = `page-btn ${currentPage === totalPages ? 'disabled' : ''}`;
    nextBtn.innerHTML = 'Next <i class="fas fa-chevron-right"></i>';
    if (currentPage < totalPages) {
        nextBtn.onclick = () => executeGlobalSearch(query, currentPage + 1);
    }
    pagination.appendChild(nextBtn);
}


function setupEventListeners() {
document.querySelectorAll('.sort-dropdown-content button[data-sort]').forEach(button => {
    button.addEventListener('click', (e) => {
        currentGlobalSort = e.currentTarget.getAttribute('data-sort');
        const textCloned = e.currentTarget.textContent.trim();
        document.getElementById('sortDropdownBtn').innerHTML = `<i class="fas fa-sort"></i> Sort: ${textCloned}`;
        executeGlobalSearch(currentSearchQuery, 1);
    });
});

const modalFavBtn = document.getElementById('modalFavoriteBtn');
if (modalFavBtn) {
    modalFavBtn.addEventListener('click', (e) => {
        toggleFavorite(e, currentModalFilename);
    });
}

// slug

document.querySelectorAll('.filter-dropdown-content button[data-filter]').forEach(button => {
    button.addEventListener('click', (e) => {
        currentGlobalFilter = e.currentTarget.getAttribute('data-filter');
        const textCloned = e.currentTarget.textContent.trim();
        document.getElementById('filterDropdownBtn').innerHTML = `<i class="fas fa-filter"></i> ${textCloned}`;
        executeGlobalSearch(currentSearchQuery, 1);
    });
});
  
  // boutons affichage
  toggleViewBtn.addEventListener("click", () => {
    isListView = !isListView;
    document.body.classList.toggle("list-view", isListView);
    toggleViewBtn.textContent = isListView ? "Gallery View" : "List View";
    lazyLoadImages();
  });
  
  // boutons copie et téléchargement
  setupCopyLinkButtons();
  setupGalleryItemClicks();

  document.addEventListener('click', async (e) => {
    const button = e.target.closest('.exclusive-btn');
    if (!button) return;
    
    e.stopPropagation();
    
    const userRole = document.body.getAttribute('data-user-role');
    const isAuthorized = document.body.getAttribute('data-is-admin') === 'true' || userRole === 'admin' || userRole === 'uploader';
    
    if (!isAuthorized) {
      alert("You do not have permission to change the exclusive status.");
      return;
    }

    const isExclusive = button.getAttribute('data-exclusive') === 'true';
    const filename = button.getAttribute('data-filename');
    
    try {
      const response = await fetch(`/update_exclusive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `filename=${encodeURIComponent(filename)}&is_exclusive=${!isExclusive}`
      });
      
      if (response.ok) {
        const data = await response.json();
        button.setAttribute('data-exclusive', data.is_exclusive.toString());
        button.classList.toggle('exclusive', data.is_exclusive);
        
        const tooltip = button.querySelector('.tooltip');
        if (tooltip) {
          tooltip.textContent = data.is_exclusive ? 'Exclusive' : 'Not Exclusive';
        }
        button.innerHTML = `<span class="tooltip">${data.is_exclusive ? 'Exclusive' : 'Not Exclusive'}</span>${data.is_exclusive ? '★' : '☆'}`;
        
        const galleryItem = button.closest('.gallery-item');
        if (galleryItem) {
          galleryItem.setAttribute('data-exclusive', data.is_exclusive.toString());
        }
      } else {
        console.error('Failed to update exclusive status');
      }
    } catch (error) {
      console.error('Error:', error);
    }
  });
  
  // modal de confirmation
  confirmCheckbox.addEventListener('change', function() {
    confirmProceed.disabled = !this.checked;
  });
  
  confirmProceed.addEventListener('click', function() {
    if (currentDownloadLink) {
      const a = document.createElement('a');
      a.href = currentDownloadLink;
      a.download = currentDownloadLink.split('filename=')[1] || 'download';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      
      confirmModal.classList.remove('active');
      confirmCheckbox.checked = false;
      confirmProceed.disabled = true;
      currentDownloadLink = null;
    }
  });
  
  confirmCancel.addEventListener('click', function() {
    confirmModal.classList.remove('active');
    confirmCheckbox.checked = false;
    confirmProceed.disabled = true;
    currentDownloadLink = null;
  });
  
  confirmModal.addEventListener('click', function(e) {
    if (e.target === confirmModal) {
      confirmModal.classList.remove('active');
      confirmCheckbox.checked = false;
      confirmProceed.disabled = true;
      currentDownloadLink = null;
    }
  });

  if (profileBtn) {
    profileBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (profileDropdown) profileDropdown.classList.toggle('active');
    });
}

// gestion logout 
  if (profileLogout) {
    profileLogout.addEventListener('click', function(e) {
      e.preventDefault(); 
      const pathParts = window.location.pathname.split('/');
      if (pathParts[1] === 'portal' && pathParts[2]) {
        const portalId = pathParts[2];
        
        fetch(`/portal/${portalId}/logout`, { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        })
        .then(res => res.json())
        .then(data => {
            if (data.redirect_url) {
                window.location.href = data.redirect_url;
            }
        })
        .catch(err => console.error("Erreur de déconnexion:", err));
      } 
      else {
        window.location.href = '/logout';
      }
    });
  }

  document.addEventListener('click', function(e) {
    if (e.target.closest('.download-btn') || e.target.closest('#modalDownloadBtn')) {
      e.preventDefault();
      
      const downloadBtn = e.target.closest('.download-btn') || e.target.closest('#modalDownloadBtn');
      const isExclusive = downloadBtn.closest('.gallery-item')?.getAttribute('data-exclusive') === 'true';
      
      if (isExclusive) {
        currentDownloadLink = downloadBtn.href;
        confirmModal.classList.add('active');
      } else {
        // download normal pour les fichiers non exclusifs
        const a = document.createElement('a');
        a.href = downloadBtn.href;
        a.download = downloadBtn.download || 'download';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    }
  });
  
  // Sidebar
  sidebarToggle.addEventListener('click', function(e) {
    e.stopPropagation();
    sidebar.classList.toggle('active');
    this.innerHTML = sidebar.classList.contains('active') ? '❮' : '❯';
  });
  
  document.addEventListener('click', function(e) {
    if (window.innerWidth < 992 && 
    !sidebar.contains(e.target) && 
    e.target !== sidebarToggle) {
      sidebar.classList.remove('active');
      sidebarToggle.innerHTML = '❯';
    }
  });
  
  // bouton ajout de dossier principal
  const addMainFolderBtn = document.getElementById('addMainFolderBtn'); 
if (addMainFolderBtn) {
    addMainFolderBtn.addEventListener('click', function() {
        if (isAdmin) {
            showFolderInput(foldersContainer);
        } else {
            alert("You don't have permission to perform this action. Only administrators can modify folders.");
        }
    });
}
  
  // gestion du profil et logout
  profileBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    profileDropdown.classList.toggle('active');
  });
  
  // fermer le dropdown quand on clique ailleurs
  document.addEventListener('click', function(e) {
    if (!e.target.closest('.profile-container')) {
      profileDropdown.classList.remove('active');
    }
  });
  
  closeModal.addEventListener('click', closeFileModal);
  fileModal.addEventListener('click', function(e) {
    if (e.target === fileModal) {
      closeFileModal();
    }
  });
  
  // pour le bouton "Add to Folder"
  const btnAddFolder = document.getElementById('addToFolderBtn');
  if (btnAddFolder) {
      btnAddFolder.addEventListener('click', function() {
          if (isAdmin) {
              const folderTree = document.getElementById('folderTree');
              folderTree.style.display = folderTree.style.display === 'none' ? 'block' : 'none';
          } else {
              alert("You don't have permission to perform this action. Only administrators can modify folders.");
          }
      });
  }

  // add to portal
  const btnAddPortal = document.getElementById('addToPortalBtn');
  if (btnAddPortal) {
      btnAddPortal.addEventListener('click', function() {
          if (isAdmin) {
              const portalList = document.getElementById('portalList');
              if (portalList) {
                  portalList.style.display = portalList.style.display === 'none' ? 'block' : 'none';
              }
          } else {
              alert("You don't have permission to perform this action. Only administrators can modify portals.");
          }
      });
  }
}


function setupCopyLinkButtons() {
  const copyButtons = document.querySelectorAll('.copy-link-btn');
  copyButtons.forEach(button => {
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const link = button.getAttribute('data-link');
      navigator.clipboard.writeText(link)
        .then(() => {
          const tooltip = button.querySelector('.tooltip');
          if (tooltip) {
            tooltip.textContent = 'Link copied!';
            setTimeout(() => {
              tooltip.textContent = 'Copy The Link';
            }, 2000);
          }
        })
        .catch(err => {
          console.error('Erreur lors de la copie: ', err);
        });
    });
  });
}

function setupExclusiveButtons() {
  document.addEventListener('click', async (e) => {
    const button = e.target.closest('.exclusive-btn');
    if (!button) return;
    
    e.stopPropagation();
    
    const userRole = document.body.getAttribute('data-user-role');
    const isAuthorized = document.body.getAttribute('data-is-admin') === 'true' || userRole === 'admin' || userRole === 'uploader';
    
    if (!isAuthorized) {
      alert("You do not have permission to change the exclusive status.");
      return;
    }

    const isExclusive = button.getAttribute('data-exclusive') === 'true';
    const filename = button.getAttribute('data-filename');
    
    try {
      const response = await fetch(`/update_exclusive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `filename=${encodeURIComponent(filename)}&is_exclusive=${!isExclusive}`
      });
      
      if (response.ok) {
        const data = await response.json();
        button.setAttribute('data-exclusive', data.is_exclusive.toString());
        button.classList.toggle('exclusive', data.is_exclusive);
        
        const tooltip = button.querySelector('.tooltip');
        if (tooltip) {
          tooltip.textContent = data.is_exclusive ? 'Exclusive' : 'Not Exclusive';
        }
        button.innerHTML = `<span class="tooltip">${data.is_exclusive ? 'Exclusive' : 'Not Exclusive'}</span>${data.is_exclusive ? '★' : '☆'}`;
        
        const galleryItem = button.closest('.gallery-item');
        if (galleryItem) {
          galleryItem.setAttribute('data-exclusive', data.is_exclusive.toString());
        }
      } else {
        console.error('Failed to update exclusive status');
      }
    } catch (error) {
      console.error('Error:', error);
    }
  });
}

function setupGalleryItemClicks() {
  const items = document.querySelectorAll('.gallery-item');
  items.forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.copy-link-btn') || 
          e.target.closest('.download-btn') || 
          e.target.closest('.exclusive-btn') ||
          e.target.closest('.select-checkbox')
        ){
        return;
      }

      if (item.classList.contains('folder-card')) {
          const folderId = item.getAttribute('data-folder-id');
          const sidebarFolderBtn = document.querySelector(`.folder[data-folder-id="${folderId}"] > .folder-name`);
          if (sidebarFolderBtn) {
              sidebarFolderBtn.click();
          }
          return; 
      }

      showFileModal(item);
    });
  });
}

function setupTooltips() {
  document.addEventListener('mouseover', function(e) {
    const tooltip = e.target.closest('.download-btn, .copy-link-btn, .exclusive-btn')?.querySelector('.tooltip');
    if (tooltip) {
      tooltip.style.left = '50%';
      tooltip.style.transform = 'translateX(-50%)';
    }
  });
}

// authentification
function promptForPassword(actionCallback) {
  if (isAdmin) {
    actionCallback();
  } 
  else {
    alert("You don't have permission to perform this action. Only administrators can modify folders.");
}
  
  const passwordModal = document.createElement('div');
  passwordModal.style.position = 'fixed';
  passwordModal.style.top = '0';
  passwordModal.style.left = '0';
  passwordModal.style.right = '0';
  passwordModal.style.bottom = '0';
  passwordModal.style.backgroundColor = 'rgba(0,0,0,0.7)';
  passwordModal.style.display = 'flex';
  passwordModal.style.justifyContent = 'center';
  passwordModal.style.alignItems = 'center';
  passwordModal.style.zIndex = '2001';
  
  const passwordContent = document.createElement('div');
  passwordContent.style.backgroundColor = 'white';
  passwordContent.style.padding = '20px';
  passwordContent.style.borderRadius = '8px';
  passwordContent.style.width = '300px';
  
  const passwordLabel = document.createElement('label');
  passwordLabel.textContent = 'Admin Password:';
  passwordLabel.style.display = 'block';
  passwordLabel.style.marginBottom = '10px';
  
  const passwordInput = document.createElement('input');
  passwordInput.type = 'password';
  passwordInput.style.width = '100%';
  passwordInput.style.padding = '8px';
  passwordInput.style.marginBottom = '15px';
  passwordInput.style.border = '1px solid #ccc';
  passwordInput.style.borderRadius = '4px';
  
  const buttonContainer = document.createElement('div');
  buttonContainer.style.display = 'flex';
  buttonContainer.style.justifyContent = 'flex-end';
  buttonContainer.style.gap = '10px';
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.padding = '8px 16px';
  cancelBtn.style.border = 'none';
  cancelBtn.style.borderRadius = '4px';
  cancelBtn.style.backgroundColor = '#f0f0f0';
  cancelBtn.style.cursor = 'pointer';
  
  const submitBtn = document.createElement('button');
  submitBtn.textContent = 'Submit';
  submitBtn.style.padding = '8px 16px';
  submitBtn.style.border = 'none';
  submitBtn.style.borderRadius = '4px';
  submitBtn.style.backgroundColor = '#16677c';
  submitBtn.style.color = 'white';
  submitBtn.style.cursor = 'pointer';
  
  cancelBtn.addEventListener('click', () => {
    document.body.removeChild(passwordModal);
  });
  
  passwordInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      submitBtn.click();
    }
  });
  
  buttonContainer.appendChild(cancelBtn);
  buttonContainer.appendChild(submitBtn);
  
  passwordContent.appendChild(passwordLabel);
  passwordContent.appendChild(passwordInput);
  passwordContent.appendChild(buttonContainer);
  passwordModal.appendChild(passwordContent);
  
  document.body.appendChild(passwordModal);
  passwordInput.focus();
}

// init
function updateUploadButtonVisibility() {
  const uploadBtn = document.querySelector('.upload-btn');
  if (uploadBtn) {
    uploadBtn.style.display = isAdmin ? 'inline-flex' : 'none';
  }
}

document.addEventListener('DOMContentLoaded', function() {
  enforceNonAdminLock();
  setupEventListeners();
  filterAndDisplay();
  lazyLoadImages();
  loadFolders();
  setProfileButtonColor();
  updateUploadButtonVisibility();
  createHeaderBubbles();
  setupTooltips();
  executeGlobalSearch('', 1);
  loadDynamicFilters();
  
 
  function handleSidebarOnResize() {
    if (window.innerWidth >= 992) {
      sidebar.classList.add('active');
      sidebarToggle.innerHTML = '❮';
    } else {
      sidebar.classList.remove('active');
      sidebarToggle.innerHTML = '❯';
    }
  }
  
  window.addEventListener('load', handleSidebarOnResize);
  window.addEventListener('resize', handleSidebarOnResize);
});

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

function enforceNonAdminLock() {
  const adminButtons = document.querySelectorAll('.add-folder-btn, .delete-folder-btn, .add-main-folder-btn');
  adminButtons.forEach(button => {
    if (!isAdmin) {
      button.classList.add('disabled');
      button.setAttribute('disabled', '');
      button.title = "Admins only";
    } 
    else {
      button.classList.remove('disabled');
      button.removeAttribute('disabled');
      button.removeAttribute('title');
    }
  });
}

function loadPortalsForModal(currentPortalId) {
  fetch('/get_all_portals')
    .then(response => response.json())
    .then(data => {
      if (currentPortalId) {
        const currentPortal = data.portals.find(p => p.id == currentPortalId);
        document.getElementById('currentPortalName').textContent = currentPortal 
            ? currentPortal.name 
            : "Unknown";
      }
       else {
        document.getElementById('currentPortalName').textContent = "None";
      }
      const portalList = document.getElementById('portalList');
      if (!portalList) return; 

      portalList.innerHTML = '';
      if(data.portals && data.portals.length > 0) {
          data.portals.forEach(portal => {
              const btn = document.createElement('button');
              btn.className = 'modern-btn secondary-btn';
              btn.style.width = '100%';
              btn.style.marginBottom = '6px';
              btn.style.justifyContent = 'flex-start';
              btn.innerHTML = `<i class="fas fa-globe"></i> ${portal.name}`;
              
              btn.onclick = () => addFileToPortal(portal.id, portal.name);
              portalList.appendChild(btn);
          });
      } else {
          portalList.innerHTML = '<span style="font-size:12px; color:var(--gray-500);">Aucun portail trouvé.</span>';
      }
    })
    .catch(err => {
        console.error("Erreur chargement portails:", err);
    });

}

function addFileToPortal(portalId, portalName) {
  if (!currentModalFilename) return;

  const formData = new FormData();
  formData.append('filename', currentModalFilename);
  formData.append('portal_id', portalId);
  
  fetch('/update_file_portal', {
    method: 'POST',
    body: formData
  })
  .then(response => response.json())
  .then(data => {
    if (data.status === 'success') {
      document.getElementById('currentPortalName').textContent = portalName;
      if (typeof loadPortalsForModal === "function") loadPortalsForModal(portalId);
      if (typeof updatePortalStats === "function") updatePortalStats(portalId);
    } else {
      alert('Error adding to portal: ' + data.message);
    }
  })
  .catch(error => console.error('Error:', error));
}

function checkFileInPortal(filename, portalId) {
  return fetch(`/get_portal_files/${portalId}`)
    .then(response => response.json())
    .then(data => {
      return data.files.includes(filename);
    })
    .catch(error => {
      console.error('Error checking file in portal:', error);
      return false;
    });
}

// === ÉCOUTEUR GLOBAL POUR LE RETRAIT D'UN PORTAIL ===
document.addEventListener('click', function(e) {
    if (e.target && e.target.id === 'removeFromPortalBtn') {
        if (confirm("Voulez-vous vraiment retirer ce fichier du portail ?")) {
            removeFileFromPortal();
        }
    }
});

function removeFileFromPortal() {
  if (!currentModalFilename) return;
  const params = new URLSearchParams();
  params.append('filename', currentModalFilename);
  
  fetch('/remove_file_portal', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params 
  })
  .then(response => response.json())
  .then(data => {
      if (data.status === 'success') {
          document.getElementById('currentPortalName').textContent = 'None';
          const btnAddPortal = document.getElementById('addToPortalBtn');
          const btnRemovePortal = document.getElementById('removeFromPortalBtn');
          if (btnAddPortal) btnAddPortal.textContent = 'Assign to Portal';
          if (btnRemovePortal) btnRemovePortal.style.display = 'none';

          const safeFilename = currentModalFilename.replace(/"/g, '\\"');
          const card = document.querySelector(`.gallery-item[data-filename="${safeFilename}"]`);
          if (card) card.setAttribute('data-portal-name', 'None');
          
          alert('Fichier retiré du portail avec succès.');
      } else {
          alert('Erreur : ' + data.message);
      }
  }).catch(err => {
      console.error('Erreur API:', err);
      alert("Erreur lors du retrait du fichier.");
  });
}

  function updatePortalStats(portalId) {
  fetch(`/portal/${portalId}/stats`)
    .then(response => response.json())
    .then(data => {
      if (data.status === 'success') {
        console.log('Portal stats updated successfully');
      }
    })
    .catch(error => console.error('Error updating portal stats:', error));
}
// maj le portail d'un fichier
function updateFilePortal(filename, portalId) {
  const formData = new FormData();
  formData.append('filename', filename);
  if (portalId) formData.append('portal_id', portalId);
  
  fetch('/update_file_portal', {
    method: 'POST',
    body: formData
  })
  .then(response => response.json())
  .then(data => {
    if (data.status === 'success') {
      // maj interface utilisateur 
      console.log('File portal updated successfully');
    } else {
      alert('Error updating portal: ' + data.message);
    }
  })
  .catch(error => console.error('Error:', error));
}

function updateFolderButtons(hasFolder) {
    const btnAddFolder = document.getElementById('addToFolderBtn');
    const btnRemoveFolder = document.getElementById('removeFromFolderBtn');
    
    if (hasFolder) {
        if (btnAddFolder) btnAddFolder.style.display = 'none';
        if (btnRemoveFolder) btnRemoveFolder.style.display = 'block';
    } 
    else {
        if (btnAddFolder) btnAddFolder.style.display = 'block';
        if (btnRemoveFolder) btnRemoveFolder.style.display = 'none';
    }
}

// supprimer un fichier d'un dossier
function removeFileFromFolder(filename) {
    if (!confirm("Are you sure you want to remove this file from its current folder?")) {
        return;
    }
    const formData = new FormData();
    formData.append('filename', filename);
    
    fetch('/remove_file_from_folder', {
        method: 'POST',
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            document.getElementById('currentFolderName').textContent = "None";
            updateFolderButtons(false);
            loadFoldersForModal(null);            
            syncFolderState(filename);
            
            setTimeout(() => {
                location.reload();
            }, 1000);
        } else {
            alert('Error removing from folder: ' + data.message);
        }
    })
    .catch(error => {
        console.error('Error:', error);
        alert('Error removing from folder: ' + error.message);
    });
}

function syncFolderState(filename) {
    fetch('/sync_file_folder', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `filename=${encodeURIComponent(filename)}`
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            console.log('Folder state synchronized successfully');
        }
    })
    .catch(error => {
        console.error('Error syncing folder state:', error);
    });
}

/*
const btnAddPortalbtn = document.getElementById('addToPortalBtn');
if (btnAddPortalbtn) {
  btnAddPortal.addEventListener('click', function() {
    if (isAdmin) {
      const portalList = document.getElementById('portalList');
      portalList.style.display = portalList.style.display === 'none' ? 'block' : 'none';
    } else {
      alert("You don't have permission to perform this action. Only administrators can modify portals.");
    }
  });
}
*/ 

function addFileToPortal(targetPortalId, portalName) {
    if (!currentModalFilename) {
        console.error("Aucun fichier sélectionné (currentModalFilename est null)");
        return;
    }
    
    const formData = new FormData();
    formData.append('filename', currentModalFilename);
    formData.append('portal_id', targetPortalId);
    
    fetch('/update_file_portal', { method: 'POST', body: formData })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            const currentPortalSpan = document.getElementById('currentPortalName');
            if (currentPortalSpan) currentPortalSpan.textContent = portalName;

            const portalList = document.getElementById('portalList');
            if (portalList) portalList.style.display = 'none';
            alert('File assigned to the portal : ' + portalName);
        } 
        else {
            alert('Erreur : ' + data.message);
        }
    })
    .catch(err => {
        console.error('Erreur API:', err);
        alert("Erreur lors de l'ajout au portail.");
    });
}

// MULTI-SELECT
let selectedFiles = [];
document.addEventListener('click', function(e) {
    const checkbox = e.target.closest('.select-checkbox');
    if (checkbox) {
        e.stopPropagation(); // Empêche d'ouvrir la modale du fichier
        const item = checkbox.closest('.gallery-item');
        const filename = item.getAttribute('data-filename');
        const link = item.getAttribute('data-link');
        item.classList.toggle('selected');
        if (item.classList.contains('selected')) {
            selectedFiles.push({ filename, link });
        } else {
            selectedFiles = selectedFiles.filter(f => f.filename !== filename);
        }
        
        updateBulkActionBar();
    }
});

function updateBulkActionBar() {
    const bar = document.getElementById('bulkActionBar');
    const countSpan = document.getElementById('bulkCount');
    
    if (!bar || !countSpan) return;

    if (selectedFiles.length > 0) {
        bar.style.display = 'flex';
        countSpan.textContent = selectedFiles.length;
    } 
    else {
        bar.style.display = 'none';
    }
}

 // filtre sur section et catégories 
    function loadDynamicFilters() {
    fetch('/get_filters_data')
        .then(res => res.json())
        .then(data => {
            const sectionContent = document.getElementById('sectionDropdownContent');
            const categoryContent = document.getElementById('categoryDropdownContent');
            if (!sectionContent || !categoryContent) return;

            sectionContent.innerHTML = '';
            categoryContent.innerHTML = '';

            //bouton "All Sections" 
            const allSecBtn = document.createElement('button');
            allSecBtn.textContent = 'All Sections';
            allSecBtn.onclick = () => setSectionFilter('all');
            sectionContent.appendChild(allSecBtn);
            // ajoute les sections de la bdd
            data.sections.forEach(sec => {
                const btn = document.createElement('button');
                btn.textContent = sec;
                btn.onclick = () => setSectionFilter(sec);
                sectionContent.appendChild(btn);
            });

            // bouton "All Categories" 
            const allCatBtn = document.createElement('button');
            allCatBtn.textContent = 'All Categories';
            allCatBtn.onclick = () => setCategoryFilter('all');
            categoryContent.appendChild(allCatBtn);

            // ajout catégories de la bdd
            data.categories.forEach(cat => {
                const btn = document.createElement('button');
                btn.textContent = cat;
                btn.onclick = () => setCategoryFilter(cat);
                categoryContent.appendChild(btn);
            });
        })
        .catch(err => console.error("Erreur chargement filtres :", err));
    }

    function setSectionFilter(section) {
        currentSectionFilter = section;
        document.getElementById('sectionFilterBtn').innerHTML = `<i class="fas fa-folder-open"></i> Section: ${section === 'all' ? 'All' : section}`;
        executeGlobalSearch(currentSearchQuery, 1);
    }

    function setCategoryFilter(category) {
        currentCategoryFilter = category;
        document.getElementById('categoryFilterBtn').innerHTML = `<i class="fas fa-list-ul"></i> Category: ${category === 'all' ? 'All' : category}`;
        executeGlobalSearch(currentSearchQuery, 1);
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

window.toggleFavorite = function(event, filename) {
    event.stopPropagation();
    const formData = new FormData();
    formData.append('filename', filename);
    fetch('/toggle_favorite', {
        method: 'POST',
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            const isFav = data.is_favorited;
            if (isFav) {
                if (!myFavorites.includes(filename)) myFavorites.push(filename);
            } 
            else {
                myFavorites = myFavorites.filter(name => name !== filename);
            }
            const galleryBtn = document.querySelector(`.gallery-item[data-filename="${filename}"] .favorite-btn`);
            if (galleryBtn) {
                galleryBtn.classList.toggle('is-favorited', isFav);
                galleryBtn.querySelector('i').className = isFav ? 'fas fa-heart' : 'far fa-heart';
                const tooltip = galleryBtn.querySelector('.tooltip');
                if (tooltip) tooltip.textContent = isFav ? 'Remove from favorites' : 'Add to favorites';
            }
            const modalFavBtn = document.getElementById('modalFavoriteBtn');
            if (modalFavBtn && currentModalFilename === filename) {
                modalFavBtn.classList.toggle('is-favorited', isFav);
                modalFavBtn.querySelector('i').className = isFav ? 'fas fa-heart' : 'far fa-heart';
            }            
            if (currentGlobalFilter === 'favorites') {
                executeGlobalSearch(currentSearchQuery, 1);
            }
        }
    });
};

document.addEventListener('DOMContentLoaded', initAboutModal);

// annuler la sélection
document.addEventListener('DOMContentLoaded', () => {
    const btnCancel = document.getElementById('bulkCancelBtn');
    if (btnCancel) {
        btnCancel.addEventListener('click', () => {
            selectedFiles = [];
            document.querySelectorAll('.gallery-item.selected').forEach(item => {
                item.classList.remove('selected');
            });
            updateBulkActionBar();
        });
    }

    // bouton copier tous les liens
    const btnCopy = document.getElementById('bulkCopyBtn');
    if (btnCopy) {
        btnCopy.addEventListener('click', () => {
            const linksText = selectedFiles.map(f => `${f.filename} :\r\n${f.link}`).join('\r\n\r\n');

            navigator.clipboard.writeText(linksText).then(() => {
                const oldContent = btnCopy.innerHTML;
                btnCopy.innerHTML = `<i class="fas fa-check"></i> Links Copied!`;
                btnCopy.style.backgroundColor = "#dcfce7";
                btnCopy.style.color = "#166534";
                setTimeout(() => {
                    btnCopy.innerHTML = oldContent;
                    btnCopy.style.backgroundColor = "";
                    btnCopy.style.color = "";
                }, 2000);
            });
        });
    }

    // télécharger tous les fichiers sélectionnés
    const btnDownload = document.getElementById('bulkDownloadBtn');
    if (btnDownload) {
        btnDownload.addEventListener('click', async () => {
            if (selectedFiles.length === 0) return;
            const originalText = btnDownload.innerHTML;
            btnDownload.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i> Compressing...`;
            btnDownload.disabled = true;
            try {
                const zip = new JSZip();
                const fetchPromises = selectedFiles.map(async (file) => {
                    const proxyUrl = '/proxy_download?url=' + encodeURIComponent(file.link);
                    const response = await fetch(proxyUrl);
                    if (!response.ok) throw new Error("download " + file.filename + " failed");
                    const blob = await response.blob();
                    zip.file(file.filename, blob)
                });
                await Promise.all(fetchPromises);
                const zipBlob = await zip.generateAsync({ type: 'blob' });
                saveAs(zipBlob, "PUR_Media_Export.zip");
                document.getElementById('bulkCancelBtn').click();
            } catch (error) {
                console.error("Error ZIP :", error);
                alert("An error occurred while creating the ZIP file. Please ensure that the files are accessible.");
            } finally {
                btnDownload.innerHTML = originalText;
                btnDownload.disabled = false;
            }
        });
    }

// download folders
window.downloadFolderAsZip = async function(folderId, btnElement) {
    const originalHtml = btnElement.innerHTML;
    btnElement.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    btnElement.disabled = true;

    try {
        const res = await fetch(`/api/export_folder_zip/${folderId}`);
        const data = await res.json();
        if (data.status !== 'success') throw new Error(data.message);
        if (data.files.length === 0) {
            alert("This folder and its sub-folders are empty.");
            return;
        }
        const btnContainer = btnElement.parentElement;
        let msgSpan = document.createElement('span');
        msgSpan.style.cssText = "font-size: 10px; color: #10b981; font-weight: bold;";
        msgSpan.textContent = "Zipping...";
        btnContainer.appendChild(msgSpan);
        const zip = new JSZip();
        const fetchPromises = data.files.map(async (file) => {
            const proxyUrl = '/proxy_download?url=' + encodeURIComponent(file.url);
            const response = await fetch(proxyUrl);
            if (!response.ok) throw new Error("Erreur sur " + file.filename);
            const blob = await response.blob();
            zip.file(file.path, blob); 
        });

        await Promise.all(fetchPromises);
        const zipBlob = await zip.generateAsync({ type: 'blob' });
        saveAs(zipBlob, `PUR_${data.folderName}.zip`);

        msgSpan.remove();
    } catch (err) {
        console.error(err);
        alert("An error occurred while creating the folder ZIP.");
    } finally {
        btnElement.innerHTML = originalHtml;
        btnElement.disabled = false;
    }
};

    // logique selection en masse pour assigner fichier a folder
    const bulkFolderBtn = document.getElementById('bulkFolderBtn');
    const bulkFolderModal = document.getElementById('bulkFolderModal');
    const bulkFolderSelect = document.getElementById('bulkFolderSelect');
    const confirmBulkFolderBtn = document.getElementById('confirmBulkFolderBtn');

    if (bulkFolderBtn) {
        bulkFolderBtn.addEventListener('click', () => {
            if (selectedFiles.length === 0) return;
            bulkFolderSelect.innerHTML = '<option value="none">No folder (Root)</option>';
            fetch('/get_folders')
                .then(res => res.json())
                .then(data => {
                    if (data.folders) {
                        data.folders.forEach(folder => {
                            const opt = document.createElement('option');
                            opt.value = folder.id;
                            opt.textContent = `🗁 ${folder.name}`;
                            bulkFolderSelect.appendChild(opt);
                        });
                    }
                    bulkFolderModal.classList.add('active');
                })
                .catch(err => console.error("Erreur de chargement des dossiers :", err));
        });
    }

    if (confirmBulkFolderBtn) {
        confirmBulkFolderBtn.addEventListener('click', () => {
            if (selectedFiles.length === 0) return;
            const targetFolderId = bulkFolderSelect.value;
            const filenamesArray = selectedFiles.map(f => f.filename);
            confirmBulkFolderBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Moving...';
            confirmBulkFolderBtn.disabled = true;
            const formData = new FormData();
            formData.append('folder_id', targetFolderId);
            formData.append('filenames', JSON.stringify(filenamesArray)); 
            fetch('/bulk_update_file_folder', {
                method: 'POST',
                body: formData
            })
            .then(res => res.json())
            .then(data => {
                if (data.status === 'success') {
                    bulkFolderModal.classList.remove('active');
                    alert(`Success! ${filenamesArray.length} items moved.`);                    
                    document.getElementById('bulkCancelBtn').click();                    
                    location.reload();
                }
                 else {
                    alert("Error: " + data.message);
                }
            })
            .catch(err => {
                console.error("Erreur lors du déplacement en masse :", err);
            })
            .finally(() => {
                confirmBulkFolderBtn.innerHTML = 'Apply to selection';
                confirmBulkFolderBtn.disabled = false;
            });
        });
    }

    // logique selection en masse pour retirer fichier d'un folder
    const bulkRemoveFolderBtn = document.getElementById('bulkRemoveFolderBtn');
    if (bulkRemoveFolderBtn) {
        bulkRemoveFolderBtn.addEventListener('click', () => {
            if (selectedFiles.length === 0) return;
            if (!confirm(`Are you sure you want to remove ${selectedFiles.length} item(s) from their folders?`)) {
                return;
            }
            const filenamesArray = selectedFiles.map(f => f.filename);
            const originalHtml = bulkRemoveFolderBtn.innerHTML;
            bulkRemoveFolderBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Removing...';
            bulkRemoveFolderBtn.disabled = true;
            const formData = new FormData();
            formData.append('folder_id', 'none'); 
            formData.append('filenames', JSON.stringify(filenamesArray));

            fetch('/bulk_update_file_folder', {
                method: 'POST',
                body: formData
            })
            .then(res => res.json())
            .then(data => {
                if (data.status === 'success') {
                    alert(`Success! ${filenamesArray.length} items have been removed from their folders.`);
                    document.getElementById('bulkCancelBtn').click();
                    location.reload();
                } 
                else {
                    alert("Error: " + data.message);
                }
            })
            .catch(err => {
                console.error("Erreur lors du retrait en masse :", err);
            })
            .finally(() => {
                bulkRemoveFolderBtn.innerHTML = originalHtml;
                bulkRemoveFolderBtn.disabled = false;
            });
        });
    }

// charger les favoris de l'utilisateur au chargement
fetch('/my_favorites')
    .then(res => res.json())
    .then(data => {
        if (data.status === 'success') {
            myFavorites = data.favorites;
            if (typeof executeGlobalSearch === 'function') executeGlobalSearch(currentSearchQuery, 1);
        }
    });

document.addEventListener('dblclick', function(e) {
    const userRole = document.body.getAttribute('data-user-role');
    const isAdminMode = document.body.getAttribute('data-is-admin') === 'true' || userRole === 'admin';
    if (!isAdminMode) return;
    const target = e.target.closest('.editable-field');
    if (!target || !currentModalFilename) return;
    if (e.target.classList.contains('modal-tag')) return;
    if (target.querySelector('input') || target.querySelector('textarea')) return;
    const field = target.getAttribute('data-field');
    let currentValue = target.textContent.trim();    
    if (field === 'tags') {
        const tagSpans = target.querySelectorAll('.modal-tag');
        const tagArray = [];
        tagSpans.forEach(span => {
            if (!span.textContent.includes('Exclusive') && span.textContent !== 'No tags') {
                tagArray.push(span.textContent.trim());
            }
        });
        currentValue = tagArray.join(', ');
    }
    
    if (['No description available', 'No description', 'None'].includes(currentValue)) currentValue = '';
    const isTextarea = field === 'description';
    const inputElement = document.createElement(isTextarea ? 'textarea' : 'input');
    
    if (!isTextarea) inputElement.type = 'text';
    inputElement.value = currentValue;
    inputElement.style.cssText = `
        width: 100%;
        font-family: inherit;
        font-size: inherit;
        font-weight: inherit;
        padding: 5px;
        border: 2px solid #16677c;
        border-radius: 4px;
        background: #ffffff;
        color: #000000;
        outline: none;
        resize: vertical;
    `;
    
    const originalHTML = target.innerHTML;
    target.innerHTML = '';
    target.appendChild(inputElement);
    inputElement.focus();
    const saveEdit = async () => {
        const newValue = inputElement.value.trim();        
        if (newValue === currentValue) {
            target.innerHTML = originalHTML;
            return;
        }

        inputElement.disabled = true;
        inputElement.style.opacity = '0.5';
        const params = new URLSearchParams();
        params.append('original_filename', currentModalFilename);
        params.append('field', field);
        params.append('value', newValue);
        try {
            const res = await fetch('/update_file_metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params
            });
            const data = await res.json();

            if (data.status === 'success') {
                if (field === 'tags') {
                    target.innerHTML = `<span style="color:#10b981; font-weight:bold; font-size:12px;">✓ Updated tags (Reload to view)</span>`;
                } 
                else {
                    target.textContent = newValue || (field === 'description' ? 'No description available' : 'None');
                }
                const safeFilename = currentModalFilename.replace(/"/g, '\\"');
                const card = document.querySelector(`.gallery-item[data-filename="${safeFilename}"], .file-card[data-filename="${safeFilename}"]`);
                
                if (card) {
                    if (field === 'filename') {
                        card.setAttribute('data-filename', newValue);
                        card.setAttribute('data-name', newValue.toLowerCase());
                        const titleElem = card.querySelector('.image-title, .file-name');
                        if (titleElem) titleElem.textContent = newValue;
                        currentModalFilename = newValue; 
                    } 
                    else if (field === 'description') {
                        card.setAttribute('data-description', newValue);
                        const descElem = card.querySelector('.file-description');
                        if (descElem) descElem.textContent = newValue;
                    }
                }
                
                target.style.backgroundColor = '#dcfce7';
                setTimeout(() => { target.style.backgroundColor = ''; }, 1000);

            } 
            else {
                alert("Erreur: " + data.message);
                target.innerHTML = originalHTML;
            }
        } catch (err) {
            console.error(err);
            alert("Erreur de connexion.");
            target.innerHTML = originalHTML;
        }
    };

    inputElement.addEventListener('blur', saveEdit);
    inputElement.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !isTextarea) {
            inputElement.blur();
        }
        if (e.key === 'Escape') {
            target.innerHTML = originalHTML;
        }
    });
});
});

// fil d'ariane 
function updateBreadcrumbs(folderId) {
    const breadcrumbContainer = document.getElementById('breadcrumbContainer');
    if (!breadcrumbContainer) return;
    if (!folderId) {
        breadcrumbContainer.style.display = 'none';
        return;
    }
    let path = [];
    let currentId = folderId;
    while (currentId) {
        const folder = globalFoldersList.find(f => f.id == currentId);
        if (folder) {
            path.unshift(folder); 
            currentId = folder.parent_id;
        } 
        else {
            break;
        }
    }

    if (path.length > 0) {
        breadcrumbContainer.style.display = 'flex';
        let html = `<div class="breadcrumb-item" onclick="resetFolderSelection()"><i class="fas fa-layer-group"></i> Library</div>`;
        
        path.forEach((f, index) => {
            html += `<span class="breadcrumb-separator">/</span>`;
            if (index === path.length - 1) {
                html += `<span class="breadcrumb-current"><i class="far fa-folder-open"></i> ${f.name}</span>`;
            } 
            else {
                html += `<div class="breadcrumb-item" onclick="triggerFolderClick(${f.id})"><i class="far fa-folder"></i> ${f.name}</div>`;
            }
        });
        
        breadcrumbContainer.innerHTML = html;
    } 
    else {
        breadcrumbContainer.style.display = 'none';
    }
}

window.triggerFolderClick = function(folderId) {
    const folderElement = document.querySelector(`.folder[data-folder-id="${folderId}"]`);
    if (!folderElement) return;
    document.querySelectorAll('.folder').forEach(f => f.classList.remove('active'));
    document.querySelectorAll('.folder-name').forEach(fn => fn.classList.remove('is-selected'));
    document.querySelectorAll('.subfolders').forEach(sub => sub.style.display = 'none');
    let current = folderElement;
    while (current && current.classList.contains('folder')) {
        current.classList.add('active');
        const sub = current.querySelector(':scope > .subfolders');
        if (sub) sub.style.display = 'block';
        current = current.parentElement.closest('.folder');
    }
    const folderName = folderElement.querySelector(':scope > .folder-name');
    if (folderName) folderName.classList.add('is-selected');
    currentFolderFilter = folderId;
    updateBreadcrumbs(currentFolderFilter);
    const gallery = document.getElementById("gallery");
    if (gallery) {
        gallery.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 50px; color: var(--gray-500);">
                <i class="fas fa-spinner fa-spin fa-2x" style="margin-bottom: 15px;"></i>
                <p style="font-family: 'Plus Jakarta Sans'; font-weight: 600;">Chargement...</p>
            </div>`;
    }
    const searchInput = document.getElementById('searchInput');
    executeGlobalSearch(searchInput ? searchInput.value.trim() : '', 1);
};

window.resetFolderSelection = function() {
    document.querySelectorAll('.folder').forEach(f => f.classList.remove('active'));
    document.querySelectorAll('.folder-name').forEach(fn => fn.classList.remove('is-selected'));
    document.querySelectorAll('.subfolders').forEach(sub => sub.style.display = 'none');
    currentFolderFilter = null;
    updateBreadcrumbs(null);
    executeGlobalSearch(document.getElementById('searchInput').value.trim(), 1);
};

