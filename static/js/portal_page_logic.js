document.addEventListener('DOMContentLoaded', function() {
  const portalId = document.body.getAttribute('data-portal-id');
  const portalEmail = document.body.getAttribute('data-portal-email');
  
  let currentModalFilename = null; 

  const profileBtn = document.getElementById('profileBtn');
  const profileDropdown = document.getElementById('profileDropdown');
  const portalLogout = document.getElementById('portalLogout');
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

  setProfileButtonColor();
  setupEventListeners();

  function setupEventListeners() {
    const btnRemoveFolder = document.getElementById('removeFromFolderBtn');
    if (btnRemoveFolder) {
        btnRemoveFolder.addEventListener('click', function() {
            if (confirm("Voulez-vous vraiment retirer ce fichier de son dossier ?")) {
                removeFileFromFolder();
            }
        });
    }

    const btnRemovePortal = document.getElementById('removeFromPortalBtn');
    if (btnRemovePortal) {
        btnRemovePortal.addEventListener('click', function() {
            if (confirm("Voulez-vous vraiment retirer ce fichier de ce portail ?")) {
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

    if (portalLogout) {
      portalLogout.addEventListener('click', logoutFromPortal);
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
        if (!e.target.closest('.download-btn')) {
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

    if(copyPortalLinkBtn) {
      copyPortalLinkBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        copyCurrentPortalLink();
      });
    }

    if(modalCopyBtn) {
      modalCopyBtn.addEventListener('click', function() {
        if (currentModalFilename && modalDownloadBtn) {
          const fileUrl = modalDownloadBtn.href;
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

    const btnAddPortal = document.getElementById('addToPortalBtn');
    if (btnAddPortal) {
      btnAddPortal.addEventListener('click', function() {
          const portalList = document.getElementById('portalList');
          if (portalList.style.display === 'none' || portalList.innerHTML === '') {
              loadPortalsForModal(); 
              portalList.style.display = 'block';
          } else {
              portalList.style.display = 'none';
          }
      });
    }

    const btnAddFolder = document.getElementById('addToFolderBtn');
    if (btnAddFolder) {
      btnAddFolder.addEventListener('click', function() {
          const folderTree = document.getElementById('folderTree');
          if (folderTree.style.display === 'none' || folderTree.innerHTML === '') {
              loadFoldersForModal(); 
              folderTree.style.display = 'block';
          } else {
              folderTree.style.display = 'none';
          }
      });
    }
  }

  function setProfileButtonColor() {
    if (portalEmail && profileBtn) {
      profileBtn.style.border = '2px solid #ffffff';
      profileBtn.style.boxShadow = '0 2px 5px rgba(0,0,0,0.15)';
      profileBtn.style.color = '#ffffff';

      const initials = profileBtn.textContent.trim();
      let hash = 0;
      for (let i = 0; i < initials.length; i++) {
        hash = initials.charCodeAt(i) + ((hash << 5) - hash);
      }
      
      const safeHue = (Math.abs(hash) % 290) + 30; 
      const color = `hsl(${safeHue}, 85%, 55%)`;
      const hoverColor = `hsl(${safeHue}, 85%, 45%)`; 
      
      profileBtn.style.backgroundColor = color;
      
      profileBtn.addEventListener('mouseenter', () => {
        profileBtn.style.backgroundColor = hoverColor;
      });
      profileBtn.addEventListener('mouseleave', () => {
        profileBtn.style.backgroundColor = color;
      });
    }
  }

  function logoutFromPortal() {
    if (confirm('Are you sure you want to log out of this portal?')) {
      fetch(`/portal/${portalId}/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },  
        credentials: 'include'
      })
      .then(response => response.json())
      .then(data => {
        window.location.href = `/portal/${portalId}/login`;
      })
      .catch(error => {
        console.error('Logout error:', error);
        window.location.href = `/portal/${portalId}/login`;
      });
    }
  }

  function searchFiles() {
    const searchTerm = searchInput.value.toLowerCase().trim();
    let visibleCount = 0;
    let totalBytes = 0;
    
    fileCards.forEach(card => {
      const fileName = card.querySelector('.file-name').textContent.toLowerCase();
      const fileDescription = card.querySelector('.file-description').textContent.toLowerCase();
      const fileTags = card.getAttribute('data-tags') || '';
      const fileSizeBytes = parseInt(card.getAttribute('data-size-bytes') || '0');
      
      if (fileName.includes(searchTerm) || fileDescription.includes(searchTerm) || fileTags.includes(searchTerm)) {
        card.style.display = 'flex'; 
        visibleCount++;
        totalBytes += fileSizeBytes;
      } else {
        card.style.display = 'none';
      }
    });
    
    if(filesCount) filesCount.textContent = `${visibleCount} items`;
    
    let totalSizeFormatted;
    if (totalBytes >= 1024 * 1024 * 1024) {
      totalSizeFormatted = `${(totalBytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
    } else if (totalBytes >= 1024 * 1024) {
      totalSizeFormatted = `${(totalBytes / (1024 * 1024)).toFixed(2)}MB`;
    } else if (totalBytes >= 1024) {
      totalSizeFormatted = `${(totalBytes / 1024).toFixed(2)}KB`;
    } else {
      totalSizeFormatted = `${totalBytes}B`;
    }
    
    if(portalFilesCount) portalFilesCount.textContent = visibleCount;
    if(portalTotalSize) portalTotalSize.textContent = totalSizeFormatted;
  }

  function showFileModal(card) {
    const filename = card.getAttribute('data-filename');
    const fileType = card.getAttribute('data-filetype');
    const downloadUrl = card.querySelector('.download-btn').getAttribute('href');
    const folderName = card.getAttribute('data-folder-name') || 'None';
    
    currentModalFilename = filename;
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalDescription').textContent = card.getAttribute('data-description') || 'No description available.';
    document.getElementById('currentFolderName').textContent = folderName;
    
    const portalNameElem = document.querySelector('header h1');
    const currentPortalSpan = document.getElementById('currentPortalName');
    if (portalNameElem && currentPortalSpan) {
        currentPortalSpan.textContent = portalNameElem.textContent;
    }

    const btnAddFolder = document.getElementById('addToFolderBtn');
    const btnRemoveFolder = document.getElementById('removeFromFolderBtn');
    const btnAddPortal = document.getElementById('addToPortalBtn');
    const btnRemovePortal = document.getElementById('removeFromPortalBtn');

    if (folderName !== 'None' && folderName !== '') {
        if (btnAddFolder) btnAddFolder.style.display = 'none';
        if (btnRemoveFolder) btnRemoveFolder.style.display = 'block';
    } else {
        if (btnAddFolder) btnAddFolder.style.display = 'block';
        if (btnRemoveFolder) btnRemoveFolder.style.display = 'none';
    }
    
    if (btnAddPortal) btnAddPortal.style.display = 'none';
    if (btnRemovePortal) btnRemovePortal.style.display = 'block';

    const tagsStr = card.getAttribute('data-tags');
    const tags = tagsStr ? tagsStr.split(',').filter(tag => tag.trim() !== '') : [];
    const modalTags = document.getElementById('modalTags');
    modalTags.innerHTML = '';
    
    if (tags.length > 0) {
        tags.forEach(tag => {
            const tagElement = document.createElement('span');
            tagElement.className = 'modal-tag';
            tagElement.textContent = tag.trim();
            modalTags.appendChild(tagElement);
        });
    } else {
        modalTags.innerHTML = '<span>No tags</span>';
    }
    
    document.getElementById('modalAddedDate').textContent = card.getAttribute('data-date-added') || 'Unknown';
    document.getElementById('modalEventDate').textContent = card.getAttribute('data-date-event') || 'Unknown';
    
    if(modalDownloadBtn) {
        modalDownloadBtn.setAttribute('href', downloadUrl);
        modalDownloadBtn.setAttribute('download', filename);
    }
    
    modalPreview.innerHTML = '';
    
    if (fileType === 'Image') {
        const img = document.createElement('img');
        img.src = downloadUrl;
        img.alt = filename;
        modalPreview.appendChild(img);
    } else if (fileType === 'Video') {
        const video = document.createElement('video');
        video.controls = true;
        video.style.width = "100%";
        const source = document.createElement('source');
        source.src = downloadUrl;
        source.type = 'video/mp4';
        video.appendChild(source);
        modalPreview.appendChild(video);
    } else if (fileType === 'PDF') {
        const iframe = document.createElement('iframe');
        iframe.src = downloadUrl;
        iframe.width = '100%';
        iframe.height = '100%';
        iframe.style.border = 'none';
        modalPreview.appendChild(iframe);
    } else {
        const placeholder = document.createElement('div');
        placeholder.style.display = 'flex';
        placeholder.style.flexDirection = 'column';
        placeholder.style.justifyContent = 'center';
        placeholder.style.alignItems = 'center';
        placeholder.style.height = '100%';
        placeholder.style.color = 'white';
        placeholder.innerHTML = '<span style="font-size: 64px; margin-bottom: 15px;">📄</span><strong>File preview not available</strong>';
        modalPreview.appendChild(placeholder);
    }
    
    fileModal.classList.add('active');
  }

  function closeFileModal() {
    fileModal.classList.remove('active');
    currentModalFilename = null;
    
    const video = modalPreview.querySelector('video');
    if (video) video.pause();
  }

  function copyCurrentPortalLink() {
    const portalLink = window.location.href;
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

  function loadPortalsForModal() {
      const portalList = document.getElementById('portalList');
      portalList.innerHTML = '<span style="color:white; font-size:12px;">Chargement...</span>';
      
      fetch('/get_all_portals') 
      .then(response => response.json())
      .then(data => {
          portalList.innerHTML = '';
          if(data.portals && data.portals.length > 0) {
              data.portals.forEach(portal => {
                  const btn = document.createElement('button');
                  btn.style.cssText = "width: 100%; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 8px; border-radius: 6px; color: white; cursor: pointer; margin-bottom: 5px; transition: background 0.2s;";
                  btn.textContent = portal.name;
                  btn.onmouseover = () => btn.style.background = "rgba(255,255,255,0.15)";
                  btn.onmouseout = () => btn.style.background = "rgba(255,255,255,0.05)";
                  
                  btn.onclick = () => addFileToPortal(portal.id, portal.name);
                  portalList.appendChild(btn);
              });
          } else {
              portalList.innerHTML = '<span style="color:white; font-size:12px;">Aucun portail trouvé.</span>';
          }
      }).catch(err => {
          console.error("Erreur chargement portails:", err);
          portalList.innerHTML = '<span style="color:#ff6b6b; font-size:12px;">Erreur de chargement</span>';
      });
  }

  function loadFoldersForModal() {
      const folderTree = document.getElementById('folderTree');
      folderTree.innerHTML = '<span style="color:white; font-size:12px;">Chargement...</span>';
      
      fetch('/get_folders')
      .then(response => response.json())
      .then(data => {
          folderTree.innerHTML = '';
          if(data.folders && data.folders.length > 0) {
              data.folders.forEach(folder => {
                  const btn = document.createElement('button');
                  btn.style.cssText = "width: 100%; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 8px; border-radius: 6px; color: white; cursor: pointer; margin-bottom: 5px; text-align: left; transition: background 0.2s;";
                  btn.innerHTML = `📁 ${folder.name}`;
                  btn.onmouseover = () => btn.style.background = "rgba(255,255,255,0.15)";
                  btn.onmouseout = () => btn.style.background = "rgba(255,255,255,0.05)";
                  
                  btn.onclick = () => addFileToFolder(folder.id, folder.name);
                  folderTree.appendChild(btn);
              });
          } else {
              folderTree.innerHTML = '<span style="color:white; font-size:12px;">Aucun dossier trouvé.</span>';
          }
      }).catch(err => {
          console.error("Erreur chargement dossiers:", err);
          folderTree.innerHTML = '<span style="color:#ff6b6b; font-size:12px;">Erreur de chargement</span>';
      });
  }

  function addFileToPortal(targetPortalId, portalName) {
      if (!currentModalFilename) return;
      
      const formData = new FormData();
      formData.append('filename', currentModalFilename);
      formData.append('portal_id', targetPortalId);
      
      fetch('/update_file_portal', { method: 'POST', body: formData })
      .then(response => response.json())
      .then(data => {
          if (data.status === 'success') {
              document.getElementById('currentPortalName').textContent = portalName;
              document.getElementById('portalList').style.display = 'none';
              alert('Fichier ajouté au portail : ' + portalName);
          } else {
              alert('Erreur : ' + data.message);
          }
      }).catch(err => {
          console.error('Erreur API:', err);
          alert("Erreur lors de l'ajout au portail.");
      });
  }

  function addFileToFolder(targetFolderId, folderName) {
      if (!currentModalFilename) return;

      const formData = new FormData();
      formData.append('filename', currentModalFilename);
      formData.append('folder_id', targetFolderId);
      
      fetch('/update_file_folder', { method: 'POST', body: formData })
      .then(response => response.json())
      .then(data => {
          if (data.status === 'success') {
              document.getElementById('currentFolderName').textContent = folderName;
              document.getElementById('folderTree').style.display = 'none';
              alert('Fichier ajouté au dossier : ' + folderName);
          } else {
              alert('Erreur : ' + data.message);
          }
      }).catch(err => {
          console.error('Erreur API:', err);
          alert("Erreur lors de l'ajout au dossier.");
      });
  }

  function removeFileFromFolder() {
      if (!currentModalFilename) return;
      const formData = new FormData();
      formData.append('filename', currentModalFilename);
      
      fetch('/remove_file_folder', { method: 'POST', body: formData })
      .then(response => response.json())
      .then(data => {
          if (data.status === 'success') {
              alert('Fichier retiré du dossier.');
              window.location.reload(); 
          } else { alert('Erreur : ' + data.message); }
      });
  }

  function removeFileFromPortal() {
      if (!currentModalFilename) return;
      const formData = new FormData();
      formData.append('filename', currentModalFilename);
      formData.append('portal_id', portalId); 
      
      fetch('/remove_file_portal', { method: 'POST', body: formData })
      .then(response => response.json())
      .then(data => {
          if (data.status === 'success') {
              alert('Fichier retiré du portail.');
              window.location.reload(); 
          } else { alert('Erreur : ' + data.message); }
      });
  }

});

window.addEventListener('pageshow', function(event) {
  if (event.persisted) {
    window.location.reload(); 
  }
});