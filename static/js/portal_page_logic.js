document.addEventListener('DOMContentLoaded', function() {
  const portalId = document.body.getAttribute('data-portal-id');
  const portalEmail = document.body.getAttribute('data-portal-email');
  
  let currentModalFilename = null; 

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

  function searchFiles() {
    const rawSearchTerm = searchInput.value.toLowerCase().trim();
    const searchWords = rawSearchTerm.split(/\s+/).filter(w => w.length > 0);
    let visibleCount = 0;
    let totalBytes = 0;
    fileCards.forEach(card => {
      const fileName = card.querySelector('.file-name').textContent.toLowerCase();
      const fileDescription = card.querySelector('.file-description').textContent.toLowerCase();
      const fileTags = card.getAttribute('data-tags') || '';
      const fileSizeBytes = parseInt(card.getAttribute('data-size-bytes') || '0');
      const combinedText = `${fileName} ${fileDescription} ${fileTags}`.toLowerCase();
      const matchesAll = searchWords.every(word => combinedText.includes(word));
      
      if (searchWords.length === 0 || matchesAll) {
        card.style.display = 'flex'; 
        visibleCount++;
        totalBytes += fileSizeBytes;
      } 
      else {
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
    const downloadUrl = card.getAttribute('data-file-url');
    const folderName = card.getAttribute('data-folder-name') || 'None';
    
    currentModalFilename = filename;
    document.getElementById('modalTitle').textContent = filename;
    document.getElementById('modalDescription').textContent = card.getAttribute('data-description') || 'No description available.';
    document.getElementById('currentFolderName').textContent = folderName;
    
    const portalNameElem = document.querySelector('header h1');
    const currentPortalSpan = document.getElementById('currentPortalName');
    if (portalNameElem && currentPortalSpan) {
        currentPortalSpan.textContent = portalNameElem.childNodes[0].textContent.trim();
    }
    const btnAddFolder = document.getElementById('addToFolderBtn');
    const btnRemoveFolder = document.getElementById('removeFromFolderBtn');
    const btnAddPortal = document.getElementById('addToPortalBtn');
    const btnRemovePortal = document.getElementById('removeFromPortalBtn');

    if (folderName !== 'None' && folderName !== '') {
        if (btnAddFolder) btnAddFolder.style.display = 'none';
        if (btnRemoveFolder) btnRemoveFolder.style.display = 'block';
    } 
    
    else {
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
    } 
    else {
        modalTags.innerHTML = '<span>No tags</span>';
    }
    
    document.getElementById('modalAddedDate').textContent = card.getAttribute('data-date-added') || 'Unknown';
    document.getElementById('modalEventDate').textContent = card.getAttribute('data-date-event') || 'Unknown';
    if(typeof modalDownloadBtn !== 'undefined' && modalDownloadBtn) {
        modalDownloadBtn.setAttribute('href', downloadUrl);
        modalDownloadBtn.setAttribute('download', filename);
    }
    
    modalPreview.innerHTML = '';
    
    if (fileType === 'Image') {
        const img = document.createElement('img');
        img.src = downloadUrl;
        img.alt = filename;
        modalPreview.appendChild(img);
    } 
    else if (fileType === 'Video') {
        const video = document.createElement('video');
        video.controls = true;
        video.style.width = "100%";
        const source = document.createElement('source');
        source.src = downloadUrl;
        source.type = 'video/mp4';
        video.appendChild(source);
        modalPreview.appendChild(video);
    } 
    
    else if (fileType === 'PDF') {
        const iframe = document.createElement('iframe');
        iframe.src = downloadUrl;
        iframe.width = '100%';
        iframe.height = '100%';
        iframe.style.border = 'none';
        modalPreview.appendChild(iframe);
    } 
    else {
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
          } 
          else {
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
      const formData = new FormData();
      formData.append('filename', currentModalFilename);
      
      fetch('/r_file_folder', { method: 'POST', body: formData })
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


  // LOGIQUE DE SELECTION MULTIPLE (PORTAILS)
  let selectedFiles = [];
  document.addEventListener('click', function(e) {
      const checkbox = e.target.closest('.select-checkbox');
      if (checkbox) {
          e.stopPropagation();
          const card = checkbox.closest('.file-card');
          const filename = card.getAttribute('data-filename');
          const link = card.getAttribute('data-file-url'); 
          card.classList.toggle('selected');
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
          countSpan.textContent = selectedFiles.length;
      } 
      else {
          bar.style.display = 'none';
      }
  }

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
                  const proxyUrl = '/proxy_download?url=' + encodeURIComponent(file.link);
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

});

window.addEventListener('pageshow', function(event) {
  if (event.persisted) {
    window.location.reload(); 
  }
});