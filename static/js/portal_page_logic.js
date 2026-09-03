// logique frontend du portail client cote visiteur (affichage des dossiers, des fichiers et téléchargement)
document.addEventListener('DOMContentLoaded', function() {
  const portalId = document.body.getAttribute('data-portal-id');
  const portalEmail = document.body.getAttribute('data-portal-email');

  function getProxyDownloadHref(fileUrl, filename) {
    return `/proxy_download?url=${encodeURIComponent(fileUrl || '')}&filename=${encodeURIComponent(filename || 'file')}`;
  }
  
  let currentModalFilename = null;
  let currentModalFileUrl = '';
  let currentModalFolderId = null;
  let currentModalPortalId = portalId || null;
  let currentModalMetadata = {};
  let currentModalFieldValues = {};
  let currentModalCard = null;
  let modalRequestToken = 0;
  let activeModalImageZoomCleanup = null;
  let showingOnlyFavorites = false;
  const portalName = document.body.getAttribute('data-portal-name') || 'Current portal';
  const canManageFiles = document.body.getAttribute('data-can-manage-files') === 'true'; 

  const profileBtn = document.getElementById('profileBtn');
  const profileDropdown = document.getElementById('profileDropdown');
  const profileLogout = document.getElementById('profileLogout');
  const portalOnlyLogout = document.getElementById('portalOnlyLogout');
  const searchInput = document.getElementById('searchInput');
  const searchButton = document.getElementById('searchButton');
  const fileCards = document.querySelectorAll('.file-card');
  const fileModal = document.getElementById('fileModal');
  const closeModal = document.getElementById('closeModal');
  const copyPortalLinkBtn = document.getElementById('copyPortalLinkBtn');
  const modalPreview = document.getElementById('modalPreview');
  const modalDownloadBtn = document.getElementById('modalDownloadBtn');
  const modalCopyBtn = document.getElementById('modalCopyBtn');
  const filesCount = document.getElementById('filesCount');
  const portalFilesCount = document.getElementById('portalFilesCount');
  const portalTotalSize = document.getElementById('portalTotalSize');
  const portalAccess = document.body.getAttribute('data-portal-access') || '';
  let myFavorites = [];

  // liste de TOUS les fichiers accessibles depuis le portail (fichiers en vrac + fichiers
  // situés dans les folders liés au portail, de façon récursive). Cette donnée est déjà
  // calculée côté serveur ; elle sert ici à retrouver les fichiers likés qui ne sont pas
  // affichés comme carte sur cette page (car rangés dans un folder).
  let allPortalFiles = [];
  try {
      const allFilesDataEl = document.getElementById('portal-all-files-data');
      if (allFilesDataEl && allFilesDataEl.textContent) {
          allPortalFiles = JSON.parse(allFilesDataEl.textContent);
      }
  } catch (error) {
      console.error('Erreur lors de la lecture des fichiers du portail :', error);
      allPortalFiles = [];
  }
  if (!Array.isArray(allPortalFiles)) allPortalFiles = [];

  // noms des fichiers déjà rendus comme carte "en vrac" sur cette page
  const looseFilenames = new Set(
      Array.from(fileCards).map(card => card.getAttribute('data-filename')).filter(Boolean)
  );

  setProfileButtonColor();
  setupEventListeners();

  fetch('/my_favorites')
      .then(res => res.json())
      .then(data => {
          if (data.status === 'success') {
              myFavorites = data.favorites;
              document.querySelectorAll('.file-card').forEach(card => {
                  const filename = card.getAttribute('data-filename');
                  if (myFavorites.includes(filename)) {
                      const btn = card.querySelector('.favorite-btn');
                      if (btn) {
                          btn.classList.add('is-favorited');
                          btn.querySelector('i').className = 'fas fa-heart';
                      }
                  }
              });
              if (showingOnlyFavorites) renderFolderLikedFiles([]);
          }
      });

  // setup des listeners d'evenements d'ouverture, fermeture, etc.
  function setupEventListeners() {
    const favoritesFilterBtn = document.getElementById('portalFavoritesFilterBtn');
    if (favoritesFilterBtn) {
        favoritesFilterBtn.addEventListener('click', function() {
            showingOnlyFavorites = !showingOnlyFavorites;
            
            // Toggle active style
            const icon = document.getElementById('portalFavoritesFilterIcon');
            if (showingOnlyFavorites) {
                favoritesFilterBtn.style.background = '#e11d48'; // red-600
                favoritesFilterBtn.style.borderColor = '#be123c';
                if (icon) {
                    icon.className = 'fas fa-heart';
                    icon.style.color = '#ffffff';
                }
            } else {
                favoritesFilterBtn.style.background = 'rgba(255,255,255,0.1)';
                favoritesFilterBtn.style.borderColor = 'var(--glass-border)';
                if (icon) {
                    icon.className = 'far fa-heart';
                    icon.style.color = '';
                }
            }
            
            // Refresh display of files list
            searchFiles();
        });
    }

    const modalFavBtn = document.getElementById('modalFavoriteBtn');
    if (modalFavBtn) {
        modalFavBtn.addEventListener('click', (e) => {
            if (currentModalFilename) {
                toggleFavorite(e, currentModalFilename);
            }
        });
    }
    const btnRemoveFolder = document.getElementById('removeFromFolderBtn');
    if (btnRemoveFolder) {
        btnRemoveFolder.addEventListener('click', function() {
            if (confirm("Do you really want to remove this file from its folder ?")) {
                removeFileFromFolder();
            }
        });
    }

    const btnRemovePortal = document.getElementById('removeFromPortalBtn');
    if (btnRemovePortal) {
        btnRemovePortal.addEventListener('click', function() {
            if (confirm("Do you really want to remove this file from this portal?")) {
                removeFileFromPortal();
            }
        });
    }

    if(profileBtn) {
      profileBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        profileDropdown.classList.toggle('active');
      });
    }

    document.addEventListener('click', function(e) {
      if (profileDropdown && !e.target.closest('.profile-container')) {
        profileDropdown.classList.remove('active');
      }
    });

    if (profileLogout) {
      profileLogout.addEventListener('click', logoutFromPortal);
    }
    if (portalOnlyLogout) {
      portalOnlyLogout.addEventListener('click', function() {
        if (confirm('Are you sure you want to log out of this portal?')) {
          window.location.href = '/portal_logout_only';
        }
      });
    }

    if(searchInput && searchButton) {
      searchInput.addEventListener('input', searchFiles);
      searchButton.addEventListener('click', searchFiles);
    }

    fileCards.forEach(card => {
      card.addEventListener('click', (e) => {
        if (!e.target.closest('.download-btn') && !e.target.closest('.select-checkbox')) {
          showFileModal(card);
        }
      });
    });

    if(closeModal) closeModal.addEventListener('click', closeFileModal);
    if(fileModal) {
      fileModal.addEventListener('click', (e) => {
        if (e.target === fileModal) closeFileModal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && fileModal?.classList.contains('active')) closeFileModal();
    });

    if(copyPortalLinkBtn) {
      copyPortalLinkBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        copyCurrentPortalLink();
      });
    }

    if(modalCopyBtn) {
      modalCopyBtn.addEventListener('click', function() {
        if (currentModalFilename && currentModalFileUrl) {
          const fileUrl = currentModalFileUrl;
          navigator.clipboard.writeText(fileUrl).then(() => {
            const originalText = modalCopyBtn.textContent;
            modalCopyBtn.textContent = '✓ Copied!';
            setTimeout(() => {
              modalCopyBtn.textContent = originalText;
            }, 2000);
          }).catch(err => {
            console.error('Failed to copy: ', err);
            alert('Failed to copy file link. Please try again.');
          });
        }
      });
    }

    if (canManageFiles) {
      document.getElementById('modalPortalSelect')?.addEventListener('change', handleModalPortalChange);
      document.getElementById('modalPortalFolderSelect')?.addEventListener('change', function(e) {
        const confirmButton = document.getElementById('confirmAssignPortalBtn');
        if (confirmButton) confirmButton.style.display = e.target.value ? 'inline-flex' : 'none';
      });
      document.getElementById('confirmAssignPortalBtn')?.addEventListener('click', confirmPortalAssignment);
      fileModal?.addEventListener('dblclick', handleModalFieldDoubleClick);
    }

    const btnAddFolder = document.getElementById('addToFolderBtn');
    if (btnAddFolder) {
      btnAddFolder.addEventListener('click', function() {

          const folderTree = document.getElementById('folderTree');
           if (folderTree.style.display === 'none' || folderTree.innerHTML === '') {
              loadFoldersForModal(); 
              folderTree.style.display = 'block';
          } 
          else {
              folderTree.style.display = 'none';

          }
      });
    }
  }

  function setProfileButtonColor() {
  const profileBtn = document.getElementById('profileBtn');
  if (profileBtn) {
    const userRole = document.body.getAttribute('data-user-role');
    const isAdmin = document.body.getAttribute('data-is-admin') === 'true';
    profileBtn.style.border = '2px solid #ffffff';
    profileBtn.style.boxShadow = '0 2px 5px rgba(0,0,0,0.15)'; 
    profileBtn.style.color = '#ffffff'; 
    if (userRole === 'admin' || isAdmin) {
      profileBtn.style.backgroundColor = '#ef4444'; 
      profileBtn.title = "Administrator";
    } 
    else if (userRole === 'basic_admin') {
      profileBtn.style.backgroundColor = '#3b82f6';
      profileBtn.title = "Moderator";
    }
    else if (userRole === 'uploader') {
      profileBtn.style.backgroundColor = '#f97316'; 
      profileBtn.title = "Uploader";
    }
    else {
      const initials = profileBtn.textContent.trim();
      let hash = 0;
      for (let i = 0; i < initials.length; i++) {
        hash = initials.charCodeAt(i) + ((hash << 5) - hash);
      }
      const safeHue = (Math.abs(hash) % 290) + 30; 
      const color = `hsl(${safeHue}, 85%, 55%)`;
      profileBtn.style.backgroundColor = color;
      profileBtn.title = "Client Portal";
    }
  }
}

  function logoutFromPortal(e) {
    if (e) e.preventDefault(); 
    if (confirm('Are you sure you want to log out of this portal?')) {
      fetch(`/portal/${portalId}/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },  
        credentials: 'include'
      })
      .then(response => response.json())
      .then(data => {
        if (data.redirect_url) {
          window.location.href = data.redirect_url;
        } else {
          window.location.href = `/portal/${portalId}/login`;
        }
      })
      .catch(error => {
        console.error('Logout error:', error);
        window.location.href = `/portal/${portalId}/login`;
      });
    }
  }

  // effectue la recherche en direct de dossiers et fichiers sur le portail
  function searchFiles() {
    const rawSearchTerm = searchInput.value.toLowerCase().trim();
    const searchWords = rawSearchTerm.split(/\s+/).filter(w => w.length > 0);
    let visibleCount = 0;
    let totalBytes = 0;

    fileCards.forEach(card => {
      const fileName = (card.querySelector('.file-name')?.textContent || card.getAttribute('data-filename') || '').toLowerCase();
      let fileDescription = (card.querySelector('.file-description')?.textContent || card.getAttribute('data-description') || '').toLowerCase().trim();
      if (['no description', 'no description available', 'no description provided.', 'none', 'null'].includes(fileDescription)) {
          fileDescription = ''; 
      }

      let fileTags = (card.getAttribute('data-tags') || '').toLowerCase();
      fileTags = fileTags.replace(/\[|\]|"|'|none|null/g, ' ').trim();
      const combinedText = ` ${fileName} ${fileDescription} ${fileTags} `;
      const matchesAll = searchWords.every(word => combinedText.includes(word));
      
      const isFav = myFavorites.includes(card.getAttribute('data-filename'));
      const matchesFavorites = !showingOnlyFavorites || isFav;
      
      if ((searchWords.length === 0 || matchesAll) && matchesFavorites) {
        card.style.display = 'flex'; 
        visibleCount++;
        totalBytes += parseInt(card.getAttribute('data-size-bytes') || '0');
      } 
      else {
        card.style.display = 'none';
      }
    });
    
    if(filesCount) filesCount.textContent = `${visibleCount} items`;
    
    // gestion en-têtes de tri par date (si activé)
    document.querySelectorAll('.files-grid').forEach(grid => {
        let hasVisibleCards = false;
        let currentHeader = null; 
        Array.from(grid.children).forEach(child => {
            if (child.classList.contains('date-group-header')) {
                if (currentHeader) currentHeader.style.display = hasVisibleCards ? 'block' : 'none';
                currentHeader = child;
                hasVisibleCards = false; 
            } else if (child.classList.contains('file-card')) {
                if (child.style.display !== 'none') hasVisibleCards = true;
            }
        });
        if (currentHeader) currentHeader.style.display = hasVisibleCards ? 'block' : 'none';
    });

    renderFolderLikedFiles(searchWords);
  }

  // construit une carte de fichier pour un fichier issu de all_portal_files_json
  // (fichier situé dans un folder lié au portail, pas affiché nativement sur cette page)
  function createFolderFileCard(file) {
    const card = document.createElement('div');
    card.className = 'file-card dynamic-folder-file';
    card.style.cursor = 'pointer';
    card.setAttribute('data-filename', file.filename || '');
    card.setAttribute('data-file-url', file.file_url || '');
    card.setAttribute('data-filetype', file.file_type || 'File');
    card.setAttribute('data-description', file.description || '');
    card.setAttribute('data-date-added', file.upload_date || '');
    card.setAttribute('data-size-bytes', '0');
    card.setAttribute('data-section', file.section || 'Not specified');
    card.setAttribute('data-category', file.category || 'Not specified');
    card.setAttribute('data-date-event', file.date_event || 'Not specified');
    card.setAttribute('data-tags', Array.isArray(file.tags) ? file.tags.join('|||') : '');
    card.setAttribute('data-folder-name', file.folder_name || 'None');

    const preview = document.createElement('div');
    preview.className = 'file-preview';
    if (file.file_type === 'Image') {
      const img = document.createElement('img');
      img.src = file.file_url || '';
      img.alt = file.filename || '';
      img.loading = 'lazy';
      preview.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'generic-placeholder';
      const docIcon = document.createElement('span');
      docIcon.className = 'doc-icon';
      docIcon.textContent = '📄';
      const docType = document.createElement('span');
      docType.className = 'doc-type';
      docType.textContent = (file.file_type || 'File').toUpperCase();
      placeholder.appendChild(docIcon);
      placeholder.appendChild(docType);
      preview.appendChild(placeholder);
    }
    card.appendChild(preview);

    const info = document.createElement('div');
    info.className = 'file-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'file-name';
    nameEl.title = file.filename || '';
    nameEl.textContent = file.filename || '';
    info.appendChild(nameEl);

    const descEl = document.createElement('div');
    descEl.className = 'file-description';
    descEl.textContent = file.description || '';
    info.appendChild(descEl);

    const detailsEl = document.createElement('div');
    detailsEl.className = 'file-details';

    const folderTag = document.createElement('span');
    folderTag.className = 'file-type';
    folderTag.style.cssText = 'opacity: .75; font-size: 12px; display: inline-flex; align-items: center; gap: 5px;';
    const folderIcon = document.createElement('i');
    folderIcon.className = 'far fa-folder';
    folderTag.appendChild(folderIcon);
    folderTag.appendChild(document.createTextNode(' ' + (file.folder_name || 'Folder')));
    detailsEl.appendChild(folderTag);

    if (file.upload_date) {
      const dateSpan = document.createElement('span');
      dateSpan.className = 'file-date';
      dateSpan.style.cssText = 'opacity: 0.6; font-size: 12px; margin-left: auto; display: inline-flex; align-items: center; gap: 5px;';
      const calIcon = document.createElement('i');
      calIcon.className = 'far fa-calendar-alt';
      dateSpan.appendChild(calIcon);
      dateSpan.appendChild(document.createTextNode(' ' + file.upload_date));
      detailsEl.appendChild(dateSpan);
    }
    info.appendChild(detailsEl);
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'file-actions';
    actions.style.cssText = 'display: flex; gap: 10px; align-items: center; justify-content: flex-end;';

    const favBtn = document.createElement('button');
    favBtn.className = 'favorite-btn is-favorited';
    const heartIcon = document.createElement('i');
    heartIcon.className = 'fas fa-heart';
    favBtn.appendChild(heartIcon);
    favBtn.addEventListener('click', (e) => window.toggleFavorite(e, file.filename));
    actions.appendChild(favBtn);

    if (portalAccess === 'Public' || canManageFiles) {
      const downloadBtn = document.createElement('a');
      downloadBtn.className = 'download-btn';
      downloadBtn.href = getProxyDownloadHref(file.file_url, file.filename);
      downloadBtn.setAttribute('download', file.filename || '');
      downloadBtn.textContent = 'Download';
      actions.appendChild(downloadBtn);
    } else {
      const viewOnly = document.createElement('span');
      viewOnly.className = 'view-only-tag';
      viewOnly.textContent = 'View Only';
      actions.appendChild(viewOnly);
    }
    card.appendChild(actions);

    card.addEventListener('click', (e) => {
      if (!e.target.closest('.download-btn') && !e.target.closest('.select-checkbox') && !e.target.closest('.favorite-btn')) {
        showFileModal(card);
      }
    });

    return card;
  }

  // retrouve (ou crée à la volée) la grille dans laquelle afficher les fichiers likés
  // provenant des folders. Si le portail n'a aucun fichier "en vrac", cette section
  // n'existe pas nativement dans le html : on la construit alors dynamiquement.
  function getOrCreateFolderFilesGrid() {
    const staticGrid = document.getElementById('looseFilesGrid');
    if (staticGrid) return staticGrid;

    let section = document.getElementById('dynamicLooseFilesSection');
    if (!section) {
      section = document.createElement('div');
      section.id = 'dynamicLooseFilesSection';
      section.className = 'loose-files-section';
      section.style.cssText = 'margin-top: 80px; padding-top: 50px; border-top: 1px solid rgba(255,255,255,0.1);';

      const header = document.createElement('div');
      header.style.cssText = 'display: flex; justify-content: flex-start; margin-bottom: 30px;';
      const capsule = document.createElement('div');
      capsule.className = 'epic-title-glass-capsule';
      capsule.style.cssText = 'padding: 10px 25px;';
      const icon = document.createElement('i');
      icon.className = 'fas fa-heart epic-title-icon';
      const title = document.createElement('h2');
      title.className = 'epic-folder-group-title';
      title.textContent = 'Liked files';
      capsule.appendChild(icon);
      capsule.appendChild(title);
      header.appendChild(capsule);

      const grid = document.createElement('div');
      grid.className = 'files-grid';
      grid.id = 'dynamicLooseFilesGrid';

      section.appendChild(header);
      section.appendChild(grid);

      const anchor = document.getElementById('searchEmptyState');
      if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(section, anchor.nextSibling);
      } else {
        document.querySelector('.showcase-grid-epic')?.parentNode?.appendChild(section);
      }
    }
    return section.querySelector('.files-grid');
  }

  // supprime la section créée dynamiquement si elle ne contient plus aucun fichier,
  // pour ne pas laisser une section "Liked files" vide sur un portail sans fichier en vrac
  function cleanupDynamicFolderFilesSection() {
    const section = document.getElementById('dynamicLooseFilesSection');
    if (!section) return;
    const grid = section.querySelector('.files-grid');
    if (!grid || grid.children.length === 0) section.remove();
  }

  // affiche, parmi les fichiers accessibles depuis le portail, ceux qui sont likés
  // et rangés dans un folder (donc absents des cartes déjà présentes dans le dom),
  // afin que le filtre/tri par likes tienne compte de tous les fichiers du portail
  function renderFolderLikedFiles(searchWords) {
    document.querySelectorAll('.file-card.dynamic-folder-file').forEach(el => el.remove());

    if (!showingOnlyFavorites) {
      cleanupDynamicFolderFilesSection();
      return;
    }

    const words = Array.isArray(searchWords) ? searchWords : [];
    const matchingFiles = allPortalFiles.filter(file => {
      if (!file || !file.filename) return false;
      if (looseFilenames.has(file.filename)) return false; // déjà affiché comme carte "en vrac"
      if (!myFavorites.includes(file.filename)) return false;

      if (words.length === 0) return true;
      const fileName = (file.filename || '').toLowerCase();
      const description = (file.description || '').toLowerCase();
      const tags = Array.isArray(file.tags) ? file.tags.join(' ').toLowerCase() : '';
      const combinedText = ` ${fileName} ${description} ${tags} `;
      return words.every(word => combinedText.includes(word));
    });

    if (matchingFiles.length > 0) {
      const grid = getOrCreateFolderFilesGrid();
      matchingFiles.forEach(file => grid.appendChild(createFolderFileCard(file)));
    }

    cleanupDynamicFolderFilesSection();
  }

  // retire la loupe active et tous ses listeners
  function clearModalImageZoom() {
    if (typeof activeModalImageZoomCleanup === 'function') {
      activeModalImageZoomCleanup();
      activeModalImageZoomCleanup = null;
    }
  }

  // installe une loupe fixe et fluide sans modifier la taille de l'image principale
  function setupModalImageZoom(image) {
    clearModalImageZoom();
    if (!image) return;

    const zoomFactor = 2.5;
    const zoomSquare = document.createElement('div');
    zoomSquare.setAttribute('aria-hidden', 'true');
    Object.assign(zoomSquare.style, {
      position: 'fixed', top: '0', left: '0', width: '180px', height: '180px',
      display: 'block', visibility: 'hidden', opacity: '0', zIndex: '10050',
      pointerEvents: 'none', boxSizing: 'border-box', overflow: 'hidden',
      border: '2px solid rgba(255,255,255,.95)', borderRadius: '14px',
      backgroundColor: '#fff', backgroundRepeat: 'no-repeat',
      boxShadow: '0 12px 32px rgba(15,23,42,.28), 0 3px 10px rgba(15,23,42,.18)',
      transition: 'opacity 120ms ease, visibility 120ms ease',
      willChange: 'transform, background-position',
      transform: 'translate3d(-9999px,-9999px,0)'
    });
    document.body.appendChild(zoomSquare);

    const previousCursor = image.style.cursor;
    image.style.cursor = 'crosshair';
    let latestPointer = null;
    let animationFrame = null;
    let hideTimer = null;
    let isVisible = false;

    const showZoom = () => {
      if (isVisible) return;
      isVisible = true;
      clearTimeout(hideTimer);
      zoomSquare.style.visibility = 'visible';
      requestAnimationFrame(() => { if (isVisible) zoomSquare.style.opacity = '1'; });
    };
    const hideZoom = () => {
      isVisible = false;
      zoomSquare.style.opacity = '0';
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!isVisible) zoomSquare.style.visibility = 'hidden';
      }, 130);
    };
    const updateZoom = () => {
      animationFrame = null;
      if (!latestPointer || !image.isConnected) return;
      const imageRect = image.getBoundingClientRect();
      if (imageRect.width <= 0 || imageRect.height <= 0) return hideZoom();

      const cursorX = Math.min(Math.max(latestPointer.clientX - imageRect.left, 0), imageRect.width);
      const cursorY = Math.min(Math.max(latestPointer.clientY - imageRect.top, 0), imageRect.height);
      const preferredSize = window.innerWidth < 640 ? 140 : 180;
      const zoomSize = Math.min(preferredSize, window.innerWidth - 24, window.innerHeight - 24);
      if (zoomSize < 80) return hideZoom();

      const backgroundWidth = imageRect.width * zoomFactor;
      const backgroundHeight = imageRect.height * zoomFactor;
      const centeredX = (zoomSize / 2) - (cursorX * zoomFactor);
      const centeredY = (zoomSize / 2) - (cursorY * zoomFactor);
      const positionX = Math.max(Math.min(0, zoomSize - backgroundWidth), Math.min(0, centeredX));
      const positionY = Math.max(Math.min(0, zoomSize - backgroundHeight), Math.min(0, centeredY));

      zoomSquare.style.width = `${zoomSize}px`;
      zoomSquare.style.height = `${zoomSize}px`;
      zoomSquare.style.backgroundImage = `url(${JSON.stringify(image.currentSrc || image.src)})`;
      zoomSquare.style.backgroundSize = `${backgroundWidth}px ${backgroundHeight}px`;
      zoomSquare.style.backgroundPosition = `${positionX}px ${positionY}px`;

      const gap = 18;
      const padding = 12;
      let left = latestPointer.clientX + gap;
      if (left + zoomSize > window.innerWidth - padding) left = latestPointer.clientX - zoomSize - gap;
      left = Math.max(padding, Math.min(left, window.innerWidth - zoomSize - padding));
      let top = latestPointer.clientY - (zoomSize / 2);
      top = Math.max(padding, Math.min(top, window.innerHeight - zoomSize - padding));
      zoomSquare.style.transform = `translate3d(${left}px,${top}px,0)`;
    };
    const scheduleUpdate = event => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      latestPointer = { clientX: event.clientX, clientY: event.clientY };
      showZoom();
      if (animationFrame === null) animationFrame = requestAnimationFrame(updateZoom);
    };
    const handleViewportChange = () => hideZoom();
    const handleImageError = () => clearModalImageZoom();

    image.addEventListener('pointerenter', scheduleUpdate);
    image.addEventListener('pointermove', scheduleUpdate);
    image.addEventListener('pointerleave', hideZoom);
    image.addEventListener('error', handleImageError);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    activeModalImageZoomCleanup = () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      clearTimeout(hideTimer);
      image.removeEventListener('pointerenter', scheduleUpdate);
      image.removeEventListener('pointermove', scheduleUpdate);
      image.removeEventListener('pointerleave', hideZoom);
      image.removeEventListener('error', handleImageError);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
      image.style.cursor = previousCursor;
      zoomSquare.remove();
    };
  }

  function parseList(value) {
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
    if (value === null || value === undefined || value === '') return [];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed)) return parsed.map(item => String(item).trim()).filter(Boolean);
        } catch (_) {}
      }
      return trimmed.split(trimmed.includes('|||') ? '|||' : ',').map(item => item.trim()).filter(Boolean);
    }
    return [String(value)];
  }

  function formatModalDate(value) {
    if (!value || value === 'Not specified' || value === 'N/A') return 'Not specified';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  }

  function setModalText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value === null || value === undefined || value === '' ? '—' : String(value);
  }

  function renderMetadataValue(elementId, value) {
    const element = document.getElementById(elementId);
    if (!element) return;
    element.innerHTML = '';
    const list = parseList(value);
    if (Array.isArray(value) || list.length > 1) {
      if (list.length === 0) {
        element.textContent = '—';
        return;
      }
      list.forEach(item => {
        const pill = document.createElement('span');
        pill.className = 'metadata-pill';
        pill.textContent = item;
        element.appendChild(pill);
      });
      return;
    }
    element.textContent = list[0] || '—';
  }

  function renderModalTags(tags) {
    const modalTags = document.getElementById('modalTags');
    if (!modalTags) return;
    const list = parseList(tags);
    modalTags.innerHTML = '';
    if (list.length === 0) {
      const emptyTag = document.createElement('span');
      emptyTag.className = 'modal-tag';
      emptyTag.textContent = 'No tags';
      modalTags.appendChild(emptyTag);
      return;
    }
    list.forEach(tagText => {
      const tagElement = document.createElement('span');
      tagElement.className = 'modal-tag';
      tagElement.textContent = tagText;
      tagElement.style.cursor = 'pointer';
      tagElement.addEventListener('click', () => {
        closeFileModal();
        if (searchInput) {
          searchInput.value = tagText;
          searchFiles();
        }
      });
      modalTags.appendChild(tagElement);
    });
  }

  function metadataValue(metadata, key) {
    const normalizeKey = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const aliases = {
      farmer_consent: ['farmer_consent', 'farmers_consent'],
      project_name: ['project_name', 'project'],
      intervention_project_type: ['intervention_project_type', 'intervention']
    };
    const acceptedKeys = new Set((aliases[key] || [key]).map(normalizeKey));
    for (const [metadataKey, value] of Object.entries(metadata || {})) {
      if (acceptedKeys.has(normalizeKey(metadataKey)) && value !== undefined && value !== null && value !== '') {
        return value;
      }
    }
    return '';
  }


  const editableDropdowns = {
    section: [
      'Agroforestry', 'Biodiversity', 'Carbon & Climate', 'Community & Livelihoods', 'Corporate', 'Events', 'General',
      'Mangrove & Coastal', 'Marketing', 'Monitoring & Reporting', 'Products', 'Projects', 'Reforestation',
      'Regenerative Agriculture', 'Supply Chain & Sourcing', 'Water & Watershed'
    ],
    category: [
      'Cereals & Grains', 'Cocoa', 'Coconut', 'Coffee', 'Cotton', 'Data Rooms', 'Fruits & Nuts', 'General', 'Guidelines',
      'Livestock & Dairy', 'Official Photos', 'Palm Oil', 'Presentations', 'Reports', 'Rubber', 'Social Media',
      'Spices', 'Tea', 'Tutorials', 'Vanilla', 'Web Banners'
    ],
    farmer_consent: ['yes', 'no'],
    activity: [
      'Agroforestry (Pre/Post)', 'Awareness', 'Beekeeping', 'Biomass Inventory', 'Carb Audit', 'Carbon Certification',
      'Cookstove', 'Cooperative', 'Feasibility Study', 'Field Study', 'Field Visit', 'Harvesting', 'Impact Study',
      'Income Diversification', 'Monitoring', 'Parcel Pre/Pruning', 'Processing', 'PreRegistration', 'Socialization',
      'Soil test', 'Training', 'Transportation', 'Theater Tour', 'Tree Distribution', 'Tree Nursery', 'Tree Planting'
    ],
    challenge: ['Animal Welfare', 'Bad agricultural practice', 'Deforestation', 'Desertification', 'Drought', 'Poor Livelihood', 'Soil erosion', 'Soil impaction', 'Wildfires', 'None'],
    commodity: ['Banana', 'Coffee', 'Cocoa', 'Carbon', 'Corn', 'Cotton', 'Cereals', 'Coconut', 'Rice', 'Sugarcane', 'Timber', 'Leather', 'Medicinal plants', 'Vanilla', 'Fruits', 'Vegetables', 'Nuts', 'Wine', 'Honey', 'Dairy', 'Flowers', 'Wool', 'Silk'],
    ecosystem_service: ['Air Quality', 'Biodiversity', 'Climate regulation', 'Cover cropping', 'Cultural/Aesthetic', 'Disease and pest regulation', 'Food', 'Medicinal Resources', 'Nutrient cycling', 'Photosynthesis', 'Pollination', 'Raw material', 'Soil formation', 'Water regulation/Purification', 'None'],
    intervention_project_type: ['Agroforestry', 'Animal', 'Awareness-raising', 'Certified Carbon', 'Cocoa', 'Coffee', 'Conservation', 'Livelihood', 'Marine', 'Reforestation', 'Regenerative Agriculture']
  };
  const multiValueMetadataFields = new Set(['activity', 'challenge', 'commodity', 'ecosystem_service', 'intervention_project_type']);

  function normalizeDateForEdit(value) {
    if (!value || value === 'Not specified' || value === 'N/A') return '';
    const stringValue = String(value).trim();
    const displayMatch = stringValue.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (displayMatch) return `${displayMatch[3]}-${displayMatch[2]}-${displayMatch[1]}`;
    const isoMatch = stringValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    const parsed = new Date(stringValue);
    if (Number.isNaN(parsed.getTime())) return stringValue;
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  }

  function normalizedMetadataKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  function metadataAliasesFor(key) {
    const aliases = {
      farmer_consent: ['farmer_consent', 'farmers_consent', 'farmerConsent'],
      project_name: ['project_name', 'project', 'projectName'],
      intervention_project_type: ['intervention_project_type', 'intervention']
    };
    return new Set((aliases[key] || [key]).map(normalizedMetadataKey));
  }

  function metadataWithUpdate(key, value) {
    const updated = { ...currentModalMetadata };
    const accepted = metadataAliasesFor(key);
    Object.keys(updated).forEach(existingKey => {
      if (accepted.has(normalizedMetadataKey(existingKey))) updated[existingKey] = value;
    });
    updated[key] = value;
    document.querySelectorAll('.editable-meta-field[data-meta-key]').forEach(element => {
      const canonicalKey = element.dataset.metaKey;
      if (updated[canonicalKey] === undefined) {
        const existingValue = metadataValue(updated, canonicalKey);
        if (existingValue !== '') updated[canonicalKey] = existingValue;
      }
    });
    return updated;
  }

  function renderEditableField(element, field, metaKey) {
    if (metaKey) {
      renderMetadataValue(element.id, metadataValue(currentModalMetadata, metaKey));
      return;
    }
    if (field === 'tags') {
      renderModalTags(currentModalFieldValues.tags || []);
      return;
    }
    const displayValue = currentModalFieldValues[field];
    if (field === 'date_ajout' || field === 'date_event') {
      setModalText(element.id, formatModalDate(displayValue));
    } else if (field === 'description') {
      setModalText(element.id, displayValue || 'No description available.');
    } else if (field === 'section' || field === 'category') {
      setModalText(element.id, displayValue || 'Not specified');
    } else {
      setModalText(element.id, displayValue || '—');
    }
  }

  function createInlineActionRow(onSave, onCancel) {
    const actions = document.createElement('div');
    actions.className = 'inline-edit-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'inline-edit-cancel';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'inline-edit-save';
    save.textContent = 'Save';
    cancel.addEventListener('click', event => {
      event.stopPropagation();
      onCancel();
    });
    save.addEventListener('click', event => {
      event.stopPropagation();
      onSave(save, cancel);
    });
    actions.append(cancel, save);
    return actions;
  }

  function updateCurrentCardAfterEdit(field, value, oldFilename) {
    const card = currentModalCard;
    if (!card) return;
    if (field === 'filename') {
      card.dataset.filename = value;
      const title = card.querySelector('.file-name');
      if (title) {
        title.textContent = value;
        title.title = value;
      }
      const favorite = card.querySelector('.favorite-btn');
      if (favorite) favorite.onclick = event => window.toggleFavorite(event, value);
      const download = card.querySelector('.download-btn');
      if (download) download.download = value;
      selectedFiles.forEach(file => {
        if (file.filename === oldFilename) file.filename = value;
      });
      const favoriteIndex = myFavorites.indexOf(oldFilename);
      if (favoriteIndex >= 0) myFavorites[favoriteIndex] = value;
    } else if (field === 'description') {
      card.dataset.description = value;
      const description = card.querySelector('.file-description');
      if (description) description.textContent = value;
    } else if (field === 'tags') {
      card.dataset.tags = value.join('|||');
    } else if (field === 'section') {
      card.dataset.section = value;
    } else if (field === 'category') {
      card.dataset.category = value;
    } else if (field === 'date_ajout') {
      card.dataset.dateAdded = value;
      const date = card.querySelector('.file-date');
      if (date) date.innerHTML = `<i class="far fa-calendar-alt"></i> ${formatModalDate(value)}`;
    } else if (field === 'date_event') {
      card.dataset.dateEvent = value;
    }
  }

  async function saveInlineEdit(element, field, metaKey, value, saveButton, cancelButton) {
    const oldFilename = currentModalFilename;
    const parameters = new URLSearchParams();
    parameters.append('original_filename', oldFilename);
    if (metaKey) {
      parameters.append('field', 'metadata');
      parameters.append('value', JSON.stringify(metadataWithUpdate(metaKey, value)));
    } else {
      parameters.append('field', field);
      parameters.append('value', field === 'tags' ? value.join(', ') : value);
    }

    saveButton.disabled = true;
    cancelButton.disabled = true;
    const originalLabel = saveButton.textContent;
    saveButton.textContent = 'Saving...';
    try {
      const response = await fetch('/update_file_metadata', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: parameters
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status !== 'success') throw new Error(data.message || 'Update failed');

      if (metaKey) {
        currentModalMetadata = metadataWithUpdate(metaKey, value);
      } else {
        currentModalFieldValues[field] = value;
        updateCurrentCardAfterEdit(field, value, oldFilename);
        if (field === 'filename') {
          currentModalFilename = value;
          currentModalFieldValues.filename = value;
          if (modalDownloadBtn) {
            modalDownloadBtn.download = value;
            modalDownloadBtn.href = getProxyDownloadHref(currentModalFileUrl, value);
          }
        }
      }
      renderEditableField(element, field, metaKey);
      element.style.backgroundColor = '#dcfce7';
      setTimeout(() => { element.style.backgroundColor = ''; }, 900);
    } catch (error) {
      alert(error.message || 'Connection error.');
      renderEditableField(element, field, metaKey);
    } finally {
      saveButton.textContent = originalLabel;
    }
  }

  function openMultiValueEditor(element, metaKey) {
    const container = document.createElement('div');
    container.className = 'inline-edit-container';
    const select = document.createElement('select');
    select.className = 'inline-edit-input';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `Add ${metaKey.replaceAll('_', ' ')}...`;
    select.appendChild(placeholder);
    editableDropdowns[metaKey].forEach(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
    let selectedValues = parseList(metadataValue(currentModalMetadata, metaKey));
    const pills = document.createElement('div');
    pills.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
    const renderPills = () => {
      pills.innerHTML = '';
      selectedValues.forEach(value => {
        const pill = document.createElement('span');
        pill.className = 'metadata-pill';
        pill.style.display = 'inline-flex';
        pill.style.alignItems = 'center';
        pill.style.gap = '5px';
        const label = document.createElement('span');
        label.textContent = value;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = `Remove ${value}`;
        remove.style.cssText = 'border:0;background:transparent;color:#dc2626;cursor:pointer;font-size:16px;line-height:1;padding:0;';
        remove.addEventListener('click', event => {
          event.stopPropagation();
          selectedValues = selectedValues.filter(item => item !== value);
          renderPills();
        });
        pill.append(label, remove);
        pills.appendChild(pill);
      });
    };
    renderPills();
    select.addEventListener('change', () => {
      if (select.value && !selectedValues.includes(select.value)) {
        selectedValues.push(select.value);
        renderPills();
      }
      select.value = '';
    });
    const actions = createInlineActionRow(
      (save, cancel) => saveInlineEdit(element, null, metaKey, selectedValues, save, cancel),
      () => renderEditableField(element, null, metaKey)
    );
    container.append(select, pills, actions);
    element.replaceChildren(container);
    select.focus();
  }

  function openSimpleEditor(element, field, metaKey) {
    const key = metaKey || field;
    const container = document.createElement('div');
    container.className = 'inline-edit-container';
    let input;
    if (editableDropdowns[key] && (key === 'section' || key === 'category' || key === 'farmer_consent')) {
      input = document.createElement('select');
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '-- Select --';
      input.appendChild(empty);
      editableDropdowns[key].forEach(value => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        input.appendChild(option);
      });
    } else if (field === 'description') {
      input = document.createElement('textarea');
      input.rows = 3;
    } else {
      input = document.createElement('input');
      input.type = field === 'date_ajout' || field === 'date_event' ? 'date' : 'text';
    }
    input.className = 'inline-edit-input';
    const currentValue = metaKey
      ? metadataValue(currentModalMetadata, metaKey)
      : (field === 'tags' ? (currentModalFieldValues.tags || []).join(', ') : currentModalFieldValues[field]);
    input.value = Array.isArray(currentValue) ? currentValue.join(', ') : (currentValue || '');
    const actions = createInlineActionRow(
      (save, cancel) => {
        const value = field === 'tags' ? parseList(input.value) : input.value.trim();
        saveInlineEdit(element, field, metaKey, value, save, cancel);
      },
      () => renderEditableField(element, field, metaKey)
    );
    container.append(input, actions);
    element.replaceChildren(container);
    input.focus();
    if (input.select && input.tagName !== 'SELECT') input.select();
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') renderEditableField(element, field, metaKey);
      if (event.key === 'Enter' && field !== 'description') actions.querySelector('.inline-edit-save')?.click();
    });
  }

  function handleModalFieldDoubleClick(event) {
    if (!canManageFiles || !currentModalFilename) return;
    if (event.target.closest('.inline-edit-container')) return;
    const element = event.target.closest('.editable-field, .editable-meta-field');
    if (!element || !fileModal?.contains(element)) return;
    event.preventDefault();
    event.stopPropagation();
    const field = element.dataset.field || null;
    const metaKey = element.dataset.metaKey || null;
    if (!field && !metaKey) return;
    if (metaKey && multiValueMetadataFields.has(metaKey)) {
      openMultiValueEditor(element, metaKey);
    } else {
      openSimpleEditor(element, field, metaKey);
    }
  }

  function renderModalPreview(fileUrl, filename, fileType) {
    clearModalImageZoom();
    modalPreview.innerHTML = '';
    const extension = (filename.split('.').pop() || '').toLowerCase();
    const normalizedType = String(fileType || '').toLowerCase();
    const isImage = normalizedType === 'image' || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(extension);
    const isVideo = normalizedType === 'video' || ['mp4', 'mov', 'avi', 'webm', 'wmv'].includes(extension);
    const isPdf = normalizedType === 'pdf' || extension === 'pdf';

    if (isImage) {
      const image = document.createElement('img');
      image.className = 'preview-image';
      image.src = fileUrl;
      image.alt = filename;
      image.draggable = false;
      modalPreview.appendChild(image);
      setupModalImageZoom(image);
    }
    else if (isVideo) {
      const video = document.createElement('video');
      video.className = 'preview-video';
      video.src = fileUrl;
      video.controls = true;
      video.playsInline = true;
      modalPreview.appendChild(video);
    }
    else if (isPdf) {
      const iframe = document.createElement('iframe');
      iframe.className = 'preview-pdf';
      iframe.src = fileUrl;
      iframe.title = filename;
      modalPreview.appendChild(iframe);
    }
    else {
      const placeholder = document.createElement('div');
      placeholder.className = 'preview-generic';
      placeholder.innerHTML = '<span style="font-size:64px;margin-bottom:15px;">📄</span><strong>File preview not available</strong>';
      modalPreview.appendChild(placeholder);
    }
  }

  function resetPortalAssignmentPanel() {
    const portalSelect = document.getElementById('modalPortalSelect');
    const folderGroup = document.getElementById('modalPortalFolderGroup');
    const folderSelect = document.getElementById('modalPortalFolderSelect');
    const confirmButton = document.getElementById('confirmAssignPortalBtn');
    if (portalSelect) portalSelect.value = '';
    if (folderGroup) folderGroup.style.display = 'none';
    if (folderSelect) {
      folderSelect.innerHTML = '<option value="">-- Select Folder --</option>';
      folderSelect.disabled = true;
    }
    if (confirmButton) confirmButton.style.display = 'none';
  }

  function applyFileDetails(file, card) {
    const filename = file.filename || file.nom_fichier || card.dataset.filename;
    const fileUrl = file.file_url || file.lien_telechargement || card.dataset.fileUrl;
    const fileType = file.file_type || file.type_doc || card.dataset.filetype;
    let metadata = file.metadata || {};
    if (typeof metadata === 'string') {
      try { metadata = JSON.parse(metadata); } catch (_) { metadata = {}; }
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};

    const tags = parseList(file.tags !== undefined ? file.tags : card.dataset.tags);
    const description = file.description || card.dataset.description || '';
    const section = file.section || card.dataset.section || '';
    const category = file.category || card.dataset.category || '';
    const dateAdded = file.date_ajout || file.upload_date || card.dataset.dateAdded || '';
    const dateEvent = file.date_event || card.dataset.dateEvent || '';
    const folderName = file.folder_name || card.dataset.folderName || 'None';

    currentModalFilename = filename;
    currentModalFileUrl = fileUrl;
    currentModalFolderId = file.folder_id || null;
    currentModalPortalId = file.portal_id || portalId || null;
    currentModalMetadata = { ...metadata };
    currentModalCard = card;
    currentModalFieldValues = {
      filename,
      description,
      section,
      category,
      date_ajout: normalizeDateForEdit(dateAdded),
      date_event: normalizeDateForEdit(dateEvent),
      tags
    };

    setModalText('modalTitle', filename);
    setModalText('modalDescription', description || 'No description available.');
    setModalText('modalSection', section || 'Not specified');
    setModalText('modalCategory', category || 'Not specified');
    setModalText('modalAddedDate', formatModalDate(dateAdded));
    setModalText('modalEventDate', formatModalDate(dateEvent));
    setModalText('currentFolderName', folderName);
    setModalText('currentPortalName', file.portal_name || portalName || 'None');
    setModalText('currentPortalFolderName', folderName);
    renderModalTags(tags);

    const fields = {
      author: 'modalMetaAuthor', copyright: 'modalMetaCopyright', cooperative: 'modalMetaCooperative',
      country: 'modalMetaCountry', farmer_consent: 'modalMetaFarmerConsent', project_name: 'modalMetaProjectName',
      region: 'modalMetaRegion', wave: 'modalMetaWave', activity: 'modalMetaActivity',
      challenge: 'modalMetaChallenge', commodity: 'modalMetaCommodity', ecosystem_service: 'modalMetaEcosystemService',
      intervention_project_type: 'modalMetaInterventionProjectType'
    };
    Object.entries(fields).forEach(([key, id]) => renderMetadataValue(id, metadataValue(currentModalMetadata, key)));

    if (modalDownloadBtn) {
      modalDownloadBtn.href = getProxyDownloadHref(fileUrl, filename);
      modalDownloadBtn.download = filename;
    }
    renderModalPreview(fileUrl, filename, fileType);

    const isFavorite = myFavorites.includes(filename);
    const modalFavorite = document.getElementById('modalFavoriteBtn');
    if (modalFavorite) {
      modalFavorite.classList.toggle('is-favorited', isFavorite);
      const icon = modalFavorite.querySelector('i');
      if (icon) icon.className = isFavorite ? 'fas fa-heart' : 'far fa-heart';
    }
    const addFolder = document.getElementById('addToFolderBtn');
    const removeFolder = document.getElementById('removeFromFolderBtn');
    const removePortal = document.getElementById('removeFromPortalBtn');
    if (addFolder) addFolder.style.display = currentModalFolderId ? 'none' : 'inline-flex';
    if (removeFolder) removeFolder.style.display = currentModalFolderId ? 'inline-flex' : 'none';
    if (removePortal) removePortal.style.display = currentModalPortalId ? 'inline-flex' : 'none';
  }

  // ouvre immédiatement le modal puis remplace les données de carte par /file_details
  async function showFileModal(card) {
    const token = ++modalRequestToken;
    const fallbackFile = {
      filename: card.dataset.filename,
      file_url: card.dataset.fileUrl,
      file_type: card.dataset.filetype,
      description: card.dataset.description,
      date_ajout: card.dataset.dateAdded,
      date_event: card.dataset.dateEvent,
      section: card.dataset.section,
      category: card.dataset.category,
      tags: card.dataset.tags,
      folder_name: card.dataset.folderName,
      portal_id: portalId,
      portal_name: portalName,
      metadata: {}
    };

    resetPortalAssignmentPanel();
    applyFileDetails(fallbackFile, card);
    fileModal.classList.add('active');
    document.body.style.overflow = 'hidden';

    try {
      const query = new URLSearchParams({ filename: fallbackFile.filename });
      if (portalId) query.set('portal_id', portalId);
      const response = await fetch(`/file_details?${query.toString()}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status === 'error') {
        throw new Error(data.message || data.error || `HTTP ${response.status}`);
      }
      if (token !== modalRequestToken || !fileModal.classList.contains('active')) return;
      const fullFile = data.file || data;
      applyFileDetails({ ...fallbackFile, ...fullFile, metadata: fullFile.metadata || {} }, card);
    } catch (error) {
      console.warn('Full file details could not be loaded; card data is kept as fallback.', error);
    } finally {
      if (canManageFiles && token === modalRequestToken && fileModal.classList.contains('active')) {
        loadPortalsForModal();
      }
    }
  }

  // ferme le modal, les sélecteurs et la loupe
  function closeFileModal() {
    if (!fileModal) return;
    fileModal.classList.remove('active');
    document.body.style.overflow = '';
    modalRequestToken++;
    clearModalImageZoom();
    resetPortalAssignmentPanel();
    const video = modalPreview.querySelector('video');
    if (video) video.pause();
  }

  function copyCurrentPortalLink() {
    const baseUrl = window.location.origin;
    const portalSlug = document.body.getAttribute('data-portal-slug');
    const portalLink = `${baseUrl}/portal/${portalSlug}/login`;
    navigator.clipboard.writeText(portalLink).then(() => {
      const originalText = copyPortalLinkBtn.innerHTML;
      copyPortalLinkBtn.innerHTML = '✓ Copied!';
      setTimeout(() => {
        copyPortalLinkBtn.innerHTML = originalText;
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy: ', err);
      alert('Failed to copy portal link. Please try again.');
    });
  }

  async function fetchPortalOptions() {
    const response = await fetch('/get_all_portals', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || 'Unable to load portals');
    return Array.isArray(data) ? data : (data.portals || []);
  }

  async function fetchLinkedPortalFolders(targetPortalId) {
    const response = await fetch(`/portal_folders/${encodeURIComponent(targetPortalId)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.status !== 'success') throw new Error(data.message || 'Unable to load portal folders');
    return Array.isArray(data.folders) ? data.folders : [];
  }

  function fillPortalSelect(select, portals, placeholder) {
    select.innerHTML = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = placeholder || 'Select a portal...';
    select.appendChild(first);
    portals.forEach(portal => {
      const option = document.createElement('option');
      option.value = portal.id;
      option.textContent = portal.name;
      select.appendChild(option);
    });
  }

  function fillPortalFolderSelect(select, folders) {
    select.innerHTML = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = folders.length ? 'Select a folder...' : 'No linked folder available';
    select.appendChild(first);
    folders.forEach(folder => {
      const option = document.createElement('option');
      option.value = folder.folder_id || folder.id;
      option.textContent = folder.folder_name || folder.name || `Folder ${option.value}`;
      select.appendChild(option);
    });
    select.disabled = folders.length === 0;
  }

  async function loadPortalsForModal() {
    const select = document.getElementById('modalPortalSelect');
    if (!select) return;
    fillPortalSelect(select, [], 'Loading portals...');
    select.disabled = true;
    try {
      fillPortalSelect(select, await fetchPortalOptions(), '-- Select a Portal --');
      select.disabled = false;
      if (currentModalPortalId && Array.from(select.options).some(option => String(option.value) === String(currentModalPortalId))) {
        select.value = String(currentModalPortalId);
        await handleModalPortalChange({ target: select }, currentModalFolderId);
      }
    } catch (error) {
      fillPortalSelect(select, [], 'Unable to load portals');
      console.error(error);
    }
  }

  async function handleModalPortalChange(event, preferredFolderId = null) {
    const targetPortalId = event.target.value;
    const group = document.getElementById('modalPortalFolderGroup');
    const select = document.getElementById('modalPortalFolderSelect');
    const confirmButton = document.getElementById('confirmAssignPortalBtn');
    if (!group || !select || !confirmButton) return;
    confirmButton.style.display = 'none';
    if (!targetPortalId) {
      group.style.display = 'none';
      fillPortalFolderSelect(select, []);
      return;
    }
    group.style.display = 'block';
    select.disabled = true;
    select.innerHTML = '<option value="">Loading linked folders...</option>';
    try {
      const folders = await fetchLinkedPortalFolders(targetPortalId);
      fillPortalFolderSelect(select, folders);
      const folderToSelect = preferredFolderId || (String(targetPortalId) === String(currentModalPortalId) ? currentModalFolderId : null);
      if (folderToSelect && Array.from(select.options).some(option => String(option.value) === String(folderToSelect))) {
        select.value = String(folderToSelect);
        confirmButton.style.display = 'inline-flex';
      }
    } catch (error) {
      select.innerHTML = '<option value="">Unable to load folders</option>';
      select.disabled = true;
      alert(error.message);
    }
  }

  async function confirmPortalAssignment() {
    const portalSelect = document.getElementById('modalPortalSelect');
    const folderSelect = document.getElementById('modalPortalFolderSelect');
    const confirmButton = document.getElementById('confirmAssignPortalBtn');
    if (!currentModalFilename || !portalSelect?.value || !folderSelect?.value || !confirmButton) return;

    const formData = new FormData();
    formData.append('filename', currentModalFilename);
    formData.append('portal_id', portalSelect.value);
    formData.append('folder_id', folderSelect.value);
    const originalText = confirmButton.textContent;
    confirmButton.disabled = true;
    confirmButton.textContent = 'Assigning...';
    try {
      const response = await fetch('/update_file_portal', {
        method: 'POST', body: formData, credentials: 'same-origin'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status !== 'success') throw new Error(data.message || 'Assignment failed');
      currentModalPortalId = portalSelect.value;
      currentModalFolderId = folderSelect.value;
      const selectedPortalName = portalSelect.options[portalSelect.selectedIndex]?.text || portalName;
      const selectedFolderName = folderSelect.options[folderSelect.selectedIndex]?.text || 'None';
      setModalText('currentPortalName', selectedPortalName);
      setModalText('currentFolderName', selectedFolderName);
      setModalText('currentPortalFolderName', selectedFolderName);
      if (currentModalCard) currentModalCard.dataset.folderName = selectedFolderName;
      document.getElementById('removeFromPortalBtn')?.style.setProperty('display', 'inline-flex');
      document.getElementById('addToFolderBtn')?.style.setProperty('display', 'none');
      document.getElementById('removeFromFolderBtn')?.style.setProperty('display', 'inline-flex');
      alert('File assigned to the selected portal and folder.');
    } catch (error) {
      alert(error.message);
    } finally {
      confirmButton.disabled = false;
      confirmButton.textContent = originalText;
    }
  }

  async function loadFoldersForModal() {
    const folderTree = document.getElementById('folderTree');
    if (!folderTree) return;
    folderTree.innerHTML = '<span style="color:#64748b;font-size:13px;font-weight:500;">Loading...</span>';
    try {
      const folders = await fetchLinkedPortalFolders(portalId);
      folderTree.innerHTML = '';
      if (folders.length === 0) {
        folderTree.innerHTML = '<span style="color:#64748b;font-size:13px;">No folder is linked to this portal.</span>';
        return;
      }
      folders.forEach(folder => {
        const folderId = folder.folder_id || folder.id;
        const folderName = folder.folder_name || folder.name || `Folder ${folderId}`;
        const button = document.createElement('button');
        button.type = 'button';
        button.style.cssText = 'width:100%;background:#f8fafc;border:1px solid #cbd5e1;padding:10px;border-radius:8px;color:#334155;font-weight:600;cursor:pointer;margin-bottom:8px;transition:all .2s;text-align:left;';
        button.textContent = `🗀 ${folderName}`;
        button.addEventListener('click', () => addFileToFolder(folderId, folderName));
        folderTree.appendChild(button);
      });
    } catch (error) {
      console.error('Error loading portal folders:', error);
      folderTree.innerHTML = '<span style="color:#ef4444;font-size:13px;">Unable to load folders.</span>';
    }
  }

  function addFileToFolder(targetFolderId, folderName) {
      if (!currentModalFilename) return;
      const params = new URLSearchParams();
      params.append('filename', currentModalFilename);
      params.append('folder_id', targetFolderId);
      if (portalId) params.append('portal_id', portalId);
      fetch('/update_file_folder', { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params 
      })
      .then(response => response.json())
      .then(data => {
          if (data.status === 'success') {
              currentModalFolderId = targetFolderId;
              document.getElementById('currentFolderName').textContent = folderName;
              setModalText('currentPortalFolderName', folderName);
              document.getElementById('folderTree').style.display = 'none';
              const btnAddFolder = document.getElementById('addToFolderBtn');
              const btnRemoveFolder = document.getElementById('removeFromFolderBtn');
              if (btnAddFolder) btnAddFolder.style.display = 'none';
              if (btnRemoveFolder) btnRemoveFolder.style.display = 'inline-flex';              
              const safeFilename = currentModalFilename.replace(/"/g, '\\"');
              const card = document.querySelector(`.file-card[data-filename="${safeFilename}"]`);
              if (card) {
                  card.setAttribute('data-folder-name', folderName);
              } 
          } 
          else {
              alert('Erreur : ' + data.message);
          }
      }).catch(err => {
          console.error('Erreur API:', err);
          alert("Erreur lors de l'ajout au dossier.");
      });
  }

  function removeFileFromFolder() {
      if (!currentModalFilename) return;
      const params = new URLSearchParams();
      params.append('filename', currentModalFilename);
      const currentPortalId = document.body.getAttribute('data-portal-id');
      if (currentPortalId) params.append('portal_id', currentPortalId);
      fetch('/remove_file_from_folder', { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params 
      })
      .then(response => response.json())
      .then(data => {
          if (data.status === 'success') {
              currentModalFolderId = null;
              document.getElementById('currentFolderName').textContent = 'None';
              setModalText('currentPortalFolderName', 'None');
              const btnAddFolder = document.getElementById('addToFolderBtn');
              const btnRemoveFolder = document.getElementById('removeFromFolderBtn');
              if (btnAddFolder) btnAddFolder.style.display = 'inline-flex';
              if (btnRemoveFolder) btnRemoveFolder.style.display = 'none';
              const safeFilename = currentModalFilename.replace(/"/g, '\\"');
              const card = document.querySelector(`.file-card[data-filename="${safeFilename}"]`);
              if (card) {
                  card.setAttribute('data-folder-name', 'None');
              }              
          } 
          else { 
              alert('Erreur : ' + data.message); 
          }
      }).catch(err => {
          console.error('Erreur API:', err);
          alert("Erreur lors du retrait du fichier.");
      });
  }

  function removeFileFromPortal() {
      if (!currentModalFilename) return;
      const formData = new FormData();
      formData.append('filename', currentModalFilename);
      formData.append('portal_id', currentModalPortalId || portalId); 
      
      fetch('/remove_file_portal', { method: 'POST', body: formData })
      .then(response => response.json())
      .then(data => {
          if (data.status === 'success') {
              alert('File removed from the portal.');
              closeFileModal();
              window.location.reload(); 
          }
           else { alert('Erreur : ' + data.message); }
      });
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


  // LOGIQUE DE SELECTION MULTIPLE ENFIN (PORTAILS) 
  let selectedFiles = [];
  document.addEventListener('click', function(e) {
      const checkbox = e.target.closest('.select-checkbox');
      if (checkbox) {
          e.stopPropagation();
          const card = checkbox.closest('.file-card');
          const filename = card.getAttribute('data-filename');
          const link = card.getAttribute('data-file-url'); 
          card.classList.toggle('selected');
          checkbox.setAttribute('role', 'checkbox');
          checkbox.setAttribute('aria-checked', card.classList.contains('selected') ? 'true' : 'false');
          if (card.classList.contains('selected')) {
              selectedFiles.push({ filename, link });
          } 
          else {
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
          countSpan.textContent = `${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''} selected`;
      } 
      else {
          bar.style.display = 'none';
      }
  }

  // fonction favoris
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
              const safeFilename = filename.replace(/"/g, '\\"');
              const cardBtn = document.querySelector(`.file-card[data-filename="${safeFilename}"] .favorite-btn`);
              if (cardBtn) {
                  cardBtn.classList.toggle('is-favorited', isFav);
                  cardBtn.querySelector('i').className = isFav ? 'fas fa-heart' : 'far fa-heart';
              }
              const modalFavBtn = document.getElementById('modalFavoriteBtn');
              if (modalFavBtn && currentModalFilename === filename) {
                  modalFavBtn.classList.toggle('is-favorited', isFav);
                  modalFavBtn.querySelector('i').className = isFav ? 'fas fa-heart' : 'far fa-heart';
              }
              // met à jour l'affichage (y compris les fichiers likés situés dans des folders)
              // si le filtre par likes est actif
              if (showingOnlyFavorites && searchInput) searchFiles();
          }
      });
  };

  const btnCancel = document.getElementById('bulkCancelBtn');
  if (btnCancel) {
      btnCancel.addEventListener('click', () => {
          selectedFiles = [];
          document.querySelectorAll('.file-card.selected').forEach(card => {
              card.classList.remove('selected');
          });
          updateBulkActionBar();
      });
  }

  const btnCopy = document.getElementById('bulkCopyBtn');
  if (btnCopy) {
      btnCopy.addEventListener('click', () => {
          const linksText = selectedFiles.map(f => `${f.filename} :\r\n${f.link}`).join('\r\n\r\n');
          navigator.clipboard.writeText(linksText).then(() => {
              const originalText = btnCopy.innerHTML;
              btnCopy.innerHTML = `<i class="fas fa-check"></i> Links Copied!`;
              btnCopy.style.backgroundColor = "#dcfce7";
              btnCopy.style.color = "#166534";
              setTimeout(() => {
                  btnCopy.innerHTML = originalText;
                  btnCopy.style.backgroundColor = "";
                  btnCopy.style.color = "";
              }, 2000);
          });
      });
  }

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
                  const proxyUrl = '/proxy_download?url=' + encodeURIComponent(file.link) + '&filename=' + encodeURIComponent(file.filename);
                  const response = await fetch(proxyUrl);
                  if (!response.ok) throw new Error("Le téléchargement de " + file.filename + " a échoué.");
                  const blob = await response.blob();
                  zip.file(file.filename, blob);
              });
              await Promise.all(fetchPromises);
              const zipBlob = await zip.generateAsync({ type: 'blob' });
              const portalName = document.querySelector('header h1')?.childNodes[0]?.textContent.trim() || "Portal";
              saveAs(zipBlob, `PUR_${portalName}_Export.zip`);
              if(btnCancel) btnCancel.click();
          } catch (error) {
              console.error("Erreur ZIP :", error);
              alert("Une erreur est survenue lors de la création du ZIP. Assurez-vous que les fichiers sont accessibles.");
          } finally {
              btnDownload.innerHTML = originalText;
              btnDownload.disabled = false;
          }
      });
  }

  // affecte la sélection complète au portail puis au folder choisi
  const bulkPortalButton = document.getElementById('bulkPortalBtn');
  const bulkPortalModal = document.getElementById('bulkPortalModal');
  const bulkPortalSelect = document.getElementById('bulkPortalSelect');
  const bulkPortalFolderSelect = document.getElementById('bulkPortalFolderSelect');
  const bulkPortalFolderGroup = document.getElementById('bulkPortalFolderGroup');
  const bulkPortalConfirm = document.getElementById('bulkPortalConfirm');

  function closeBulkPortalModal() {
    if (!bulkPortalModal) return;
    bulkPortalModal.classList.remove('active');
    if (bulkPortalSelect) bulkPortalSelect.value = '';
    if (bulkPortalFolderGroup) bulkPortalFolderGroup.style.display = 'none';
    if (bulkPortalFolderSelect) {
      bulkPortalFolderSelect.innerHTML = '<option value="">Select a portal first...</option>';
      bulkPortalFolderSelect.disabled = true;
    }
    if (bulkPortalConfirm) bulkPortalConfirm.disabled = true;
  }

  if (bulkPortalButton && bulkPortalModal && canManageFiles) {
    bulkPortalButton.addEventListener('click', async () => {
      if (selectedFiles.length === 0) return;
      bulkPortalModal.classList.add('active');
      const count = document.getElementById('bulkPortalSelectedCount');
      if (count) count.textContent = selectedFiles.length;
      fillPortalSelect(bulkPortalSelect, [], 'Loading portals...');
      bulkPortalSelect.disabled = true;
      try {
        fillPortalSelect(bulkPortalSelect, await fetchPortalOptions(), 'Select a portal...');
        bulkPortalSelect.disabled = false;
      } catch (error) {
        fillPortalSelect(bulkPortalSelect, [], 'Unable to load portals');
        alert(error.message);
      }
    });

    bulkPortalSelect?.addEventListener('change', async () => {
      bulkPortalConfirm.disabled = true;
      if (!bulkPortalSelect.value) {
        bulkPortalFolderGroup.style.display = 'none';
        fillPortalFolderSelect(bulkPortalFolderSelect, []);
        return;
      }
      bulkPortalFolderGroup.style.display = 'block';
      bulkPortalFolderSelect.disabled = true;
      bulkPortalFolderSelect.innerHTML = '<option value="">Loading linked folders...</option>';
      try {
        fillPortalFolderSelect(bulkPortalFolderSelect, await fetchLinkedPortalFolders(bulkPortalSelect.value));
      } catch (error) {
        bulkPortalFolderSelect.innerHTML = '<option value="">Unable to load folders</option>';
        bulkPortalFolderSelect.disabled = true;
        alert(error.message);
      }
    });

    bulkPortalFolderSelect?.addEventListener('change', () => {
      bulkPortalConfirm.disabled = !bulkPortalFolderSelect.value;
    });

    bulkPortalConfirm?.addEventListener('click', async () => {
      if (!bulkPortalSelect.value || !bulkPortalFolderSelect.value || selectedFiles.length === 0) return;
      const formData = new FormData();
      formData.append('portal_id', bulkPortalSelect.value);
      formData.append('folder_id', bulkPortalFolderSelect.value);
      formData.append('filenames', JSON.stringify(selectedFiles.map(file => file.filename)));
      const originalText = bulkPortalConfirm.innerHTML;
      bulkPortalConfirm.disabled = true;
      bulkPortalConfirm.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Assigning...';
      try {
        const response = await fetch('/bulk_update_file_portal', {
          method: 'POST', body: formData, credentials: 'same-origin'
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.status !== 'success') throw new Error(data.message || 'Bulk assignment failed');
        closeBulkPortalModal();
        alert(data.message || 'Selected files assigned successfully.');
        window.location.reload();
      } catch (error) {
        alert(error.message);
      } finally {
        bulkPortalConfirm.innerHTML = originalText;
        bulkPortalConfirm.disabled = !(bulkPortalSelect.value && bulkPortalFolderSelect.value);
      }
    });

    document.getElementById('bulkPortalModalClose')?.addEventListener('click', closeBulkPortalModal);
    document.getElementById('bulkPortalCancel')?.addEventListener('click', closeBulkPortalModal);
    bulkPortalModal.addEventListener('click', event => {
      if (event.target === bulkPortalModal) closeBulkPortalModal();
    });
  }

  // LOGIQUE DE TRI SÉCURISÉE (CÔTÉ CLIENT)
  const sortDropdownBtn = document.getElementById('sortDropdownBtn');
  const sortDropdownContent = document.getElementById('sortDropdownContent');
  function applySortAndGroup(grid, sortType) {
      const cards = Array.from(grid.querySelectorAll('.file-card'));      
      grid.querySelectorAll('.date-group-header').forEach(h => h.remove());

      cards.sort((a, b) => {
          if (sortType === 'name_asc') {
              return (a.getAttribute('data-filename') || "").localeCompare(b.getAttribute('data-filename') || "");
          }
          else if (sortType === 'name_desc') {
              return (b.getAttribute('data-filename') || "").localeCompare(a.getAttribute('data-filename') || "");
          } 
          else if (sortType === 'date_desc') {
              const parseDate = (dStr) => {
                  if (!dStr || dStr.trim() === '') return 0;
                  const parts = dStr.split('-');
                  if (parts.length === 3) {
                      return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
                  }
                  return 0;
              };
              return parseDate(b.getAttribute('data-date-added')) - parseDate(a.getAttribute('data-date-added'));
          }
          return 0;
      });
      
      if (sortType === 'date_desc') {
          let currentDateGroup = null;
          cards.forEach(card => {
              const fileDate = card.getAttribute('data-date-added') || 'Old files (undated)';
              if (fileDate !== currentDateGroup) {
                  currentDateGroup = fileDate;
                  const dateHeader = document.createElement('div');
                  dateHeader.className = 'date-group-header';
                  dateHeader.style.cssText = 'grid-column: 1 / -1; font-size: 22px; font-weight: 800; color: #16677c; margin-top: 20px; margin-bottom: 5px; border-bottom: 2px solid #e2e8f0; padding-bottom: 5px; width: 100%;';
                  dateHeader.textContent = fileDate;
                  grid.appendChild(dateHeader);
              }
              grid.appendChild(card);
          });
      } 
      else {
          cards.forEach(card => grid.appendChild(card));
      }
  }

  document.querySelectorAll('.files-grid').forEach(grid => {
      applySortAndGroup(grid, 'date_desc');
  });

  if (sortDropdownBtn && sortDropdownContent) {
      sortDropdownBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const isDisplayed = sortDropdownContent.style.display === 'block';
          sortDropdownContent.style.display = isDisplayed ? 'none' : 'block';
      });
      document.addEventListener('click', () => {
          sortDropdownContent.style.display = 'none';
      });
      sortDropdownContent.querySelectorAll('button[data-sort]').forEach(button => {
          button.addEventListener('click', (e) => {
              const sortType = e.currentTarget.getAttribute('data-sort');
              sortDropdownBtn.innerHTML = e.currentTarget.innerHTML;
              document.querySelectorAll('.files-grid').forEach(grid => {
                  applySortAndGroup(grid, sortType);
              });
          });
      });
  }
  
});

window.addEventListener('pageshow', function(event) {
  if (event.persisted) {
    window.location.reload(); 
  }
});

(function () {
  const grid = document.getElementById('foldersContainerGrid');
  const isAdmin = document.body.dataset.isAdmin === 'true';
  const editBtn = document.getElementById('editLayoutBtn');
  const saveBtn = document.getElementById('saveLayoutBtn');
  if (!grid || !isAdmin || !editBtn) return;   
  const COLS = 4;        
  const MAX_ROW = 3;     
  let editMode = false;
  let sortable = null;
 
  function cellMetrics() {
    const s = getComputedStyle(grid);
    const gap = parseFloat(s.columnGap) || 0;
    const rowGap = parseFloat(s.rowGap) || gap;
    const cellW = (grid.clientWidth - gap * (COLS - 1)) / COLS;
    const rowH = parseFloat(s.gridAutoRows) || 280;
    return { unitX: cellW + gap, unitY: rowH + rowGap };
  }
 
  function spanOf(block, axis) {
    const jsProp = axis === 'col' ? block.style.gridColumn : block.style.gridRow;
    if (jsProp) {
      const m = /span\s+(\d+)/.exec(jsProp);
      if (m) return parseInt(m[1], 10);
    }
    const styleAttr = block.getAttribute('style') || '';
    const regex = axis === 'col' ? /grid-column:[^;]*span\s+(\d+)/ : /grid-row:[^;]*span\s+(\d+)/;
    const match = regex.exec(styleAttr);
    if (match && match[1]) return parseInt(match[1], 10);
    return 1;
  }
 
  function makeResizable(block, handle, axis) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const { unitX, unitY } = cellMetrics();
      const start = axis === 'col' ? e.pageX : e.pageY;
      const startSpan = spanOf(block, axis);
      const unit = axis === 'col' ? unitX : unitY;
      const max = axis === 'col' ? COLS : 5; 
      const move = (ev) => {
        const delta = (axis === 'col' ? ev.pageX : ev.pageY) - start;
        let span = Math.round(startSpan + delta / unit);
        span = Math.max(1, Math.min(max, span));
        if (axis === 'col') {
            block.style.gridColumn = 'span ' + span;
        } 
        else {
            block.style.gridRow = 'span ' + span;
            block.style.height = (span * 280 + (span - 1) * 40) + 'px';
        }
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }
 
  function addHandles(block) {
    if (block.querySelector('.resize-r')) return;
    [['resize-r', 'col'], ['resize-b', 'row']].forEach(([cls, axis]) => {
      const h = document.createElement('div');
      h.className = 'resize-handle ' + cls;
      block.appendChild(h);
      makeResizable(block, h, axis);
    });
  }
 
  function removeHandles() {
    grid.querySelectorAll('.resize-handle').forEach(h => h.remove());
  }
 
  grid.addEventListener('click', (e) => {
    if (editMode) { 
      if (e.target.closest('.edit-title-btn')) return;
      e.stopPropagation(); 
      e.preventDefault(); 
    }
  }, true);
 
  function toggleEdit() {
    editMode = !editMode;
    grid.classList.toggle('editing', editMode);
    saveBtn.style.display = editMode ? 'inline-flex' : 'none';
    editBtn.innerHTML = editMode
      ? '<i class="fas fa-times"></i> Cancel'
      : '<i class="fas fa-table-cells"></i> Edit layout';
 
    if (editMode) {
      grid.querySelectorAll('.epic-folder-block').forEach(addHandles);
      grid.querySelectorAll('.epic-folder-block').forEach(addTitleButton); 
      if (window.Sortable) {
        sortable = window.Sortable.create(grid, {
          animation: 350, 
          easing: "cubic-bezier(0.25, 1, 0.5, 1)", 
          draggable: '.epic-folder-block',
          handle: '.epic-glass-card',
          filter: '.resize-handle, .edit-title-btn', 
          preventOnFilter: false,
          forceFallback: true,      
          fallbackTolerance: 3,     
          swap: true,
          swapClass: 'sortable-swap-highlight',
          ghostClass: 'sortable-ghost',
          dragClass: 'sortable-drag'
        });
      }
    } 
    else {
      removeHandles();
      grid.querySelectorAll('.epic-folder-block').forEach(removeTitleButton); 
      if (sortable) { sortable.destroy(); sortable = null; }
    }
}

function addTitleButton(block) {
    if (block.querySelector('.edit-title-btn')) return;
    const titleBtn = document.createElement('button');
    titleBtn.innerHTML = '<i class="fas fa-heading"></i>';
    titleBtn.className = 'edit-title-btn'; 
    titleBtn.style.cssText = "position: absolute; top: -15px; left: 50%; transform: translateX(-50%); z-index: 50; background: #16677c; color: white; border: none; border-radius: 50%; width: 36px; height: 36px; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.3); transition: 0.2s;";
    if (block.getAttribute('data-custom-title') && block.getAttribute('data-custom-title').trim() !== "") {
        titleBtn.style.background = "#10b981"; 
    }
    
    titleBtn.onclick = (e) => {
        e.stopPropagation(); 
        const currentTitle = block.getAttribute('data-custom-title') || "";
        const currentColor = block.getAttribute('data-custom-title-color') || "#000000";
        const popupOverlay = document.createElement('div');
        popupOverlay.style.cssText = "position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 9999; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(5px);";
        const popupBox = document.createElement('div');
        popupBox.style.cssText = "background: white; padding: 25px; border-radius: 12px; width: 350px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); font-family: inherit;";
        popupBox.innerHTML = `
            <h3 style="margin: 0 0 15px 0; color: #333;">Edit Section Title</h3>
            <label style="display: block; margin-bottom: 5px; font-weight: 600; font-size: 14px;">Title text (leave blank to delete):</label>
            <input type="text" id="popupTitleInput" value="${currentTitle}" style="width: 100%; padding: 10px; margin-bottom: 15px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box;">
            
            <label style="display: block; margin-bottom: 5px; font-weight: 600; font-size: 14px;">Title Color:</label>
            <input type="color" id="popupColorInput" value="${currentColor}" style="width: 100%; height: 40px; border: none; border-radius: 6px; cursor: pointer; margin-bottom: 25px; padding: 0;">
            
            <div style="display: flex; justify-content: flex-end; gap: 10px;">
                <button id="popupCancel" style="padding: 8px 16px; border: none; background: #e2e8f0; border-radius: 6px; cursor: pointer; font-weight: bold;">Cancel</button>
                <button id="popupSave" style="padding: 8px 16px; border: none; background: #16677c; color: white; border-radius: 6px; cursor: pointer; font-weight: bold;">Save</button>
            </div>
        `;
        
        popupOverlay.appendChild(popupBox);
        document.body.appendChild(popupOverlay);
        document.getElementById('popupCancel').onclick = () => popupOverlay.remove();
        document.getElementById('popupSave').onclick = () => {
            const newTitle = document.getElementById('popupTitleInput').value.trim();
            const newColor = document.getElementById('popupColorInput').value;
            block.setAttribute('data-custom-title', newTitle);
            block.setAttribute('data-custom-title-color', newColor);
            titleBtn.style.background = newTitle !== "" ? "#10b981" : "#16677c";
            popupOverlay.remove();
        };
    };
    block.appendChild(titleBtn);
}

function removeTitleButton(block) {
    const btn = block.querySelector('.edit-title-btn');
    if (btn) btn.remove();
}
 
  // sauvegarde la disposition de la grille bento du portail en bdd
  async function saveLayout() {
    const items = Array.from(grid.querySelectorAll('.epic-folder-block')).map((b, i) => ({
      folder_id: parseInt(b.dataset.folderId, 10),
      col_span: spanOf(b, 'col'),
      row_span: spanOf(b, 'row'),
      position: i,
      custom_title: b.getAttribute('data-custom-title') || null ,
      custom_title_color: b.getAttribute('data-custom-title-color') || '#000000' 
    }));
 
    const slug = document.body.dataset.portalSlug;
    const fd = new FormData();
    fd.append('layout', JSON.stringify(items));
 
    const original = saveBtn.innerHTML;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    try {
      const res = await fetch('/portal/' + slug + '/layout', { method: 'POST', body: fd });
      const data = await res.json();
      if (data.status === 'success') {
        window.location.reload();         
      } 
      else {
        alert('Erreur: ' + (data.message || 'sauvegarde impossible'));
        saveBtn.innerHTML = original;
      }
    } catch (err) {
      console.error('saveLayout error:', err);
      alert('Erreur réseau lors de la sauvegarde.');
      saveBtn.innerHTML = original;
    }
  }
 
  editBtn.addEventListener('click', toggleEdit);
  saveBtn.addEventListener('click', saveLayout);
})();