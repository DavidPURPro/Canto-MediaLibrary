// logique frontend de la page d'upload (gestion du drag&drop, des metadata et de l'envoi ajax)
// Role management matching canto_logic.js
const isAdmin = document.body.getAttribute('data-is-admin') === 'true';
const userRole = document.body.getAttribute('data-user-role');
const isBasicAdmin = userRole === 'basic_admin';

// Globals for Custom Precision Metadata
let globalMetaArrays = {
    activity: [],
    challenge: [],
    commodity: [],
    ecosystem_service: [],
    intervention_project_type: []
};

let fileMetaArrays = {
    activity: [],
    challenge: [],
    commodity: [],
    ecosystem_service: [],
    intervention_project_type: []
};

// ajoute un tag de metadata globale
window.addGlobalMetaTag = function(key, selectElement) {
    const val = selectElement.value;
    if (!val) return;
    if (!globalMetaArrays[key].includes(val)) {
        globalMetaArrays[key].push(val);
        renderMetaPills('global', key);
    }
    selectElement.selectedIndex = 0;
};

// ajoute un tag de metadata individuelle
window.addFileMetaTag = function(key, selectElement) {
    const val = selectElement.value;
    if (!val) return;
    if (!fileMetaArrays[key].includes(val)) {
        fileMetaArrays[key].push(val);
        renderMetaPills('file', key);
    }
    selectElement.selectedIndex = 0;
};

window.removeMetaTag = function(scope, key, val) {
    const array = scope === 'global' ? globalMetaArrays[key] : fileMetaArrays[key];
    const index = array.indexOf(val);
    if (index > -1) {
        array.splice(index, 1);
        renderMetaPills(scope, key);
    }
};

function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

function renderMetaPills(scope, key) {
    const array = scope === 'global' ? globalMetaArrays[key] : fileMetaArrays[key];
    let idSuffix = capitalizeFirstLetter(key);
    if (key === 'intervention_project_type') idSuffix = 'Intervention';
    if (key === 'ecosystem_service') idSuffix = 'EcosystemService';
    
    const container = document.getElementById(scope === 'global' ? `globalMeta${idSuffix}Tags` : `fileMeta${idSuffix}Tags`);
    if (!container) return;
    
    container.innerHTML = '';
    array.forEach(val => {
        const pill = document.createElement('span');
        pill.className = 'meta-pill';
        pill.innerHTML = `${val} <i class="fas fa-times" onclick="removeMetaTag('${scope}', '${key}', '${val}')"></i>`;
        container.appendChild(pill);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    const fileEventDate = document.getElementById("fileEventDate");
    const dropArea = document.getElementById("drop-area");
    const fileInput = document.getElementById("fileElem");
    const sendBtn = document.getElementById("sendBtn");
    const msg = document.getElementById("msg");
    const fileList = document.getElementById("fileList");
    const loadingSpinner = document.getElementById("loadingSpinner");
    const MAX_FILES = 35;
    let filesToUpload = [];
    let fileDetails = {};
    const modal = document.getElementById("fileDetailsModal");
    const closeBtn = document.querySelector(".close-btn");
    const cancelBtn = document.getElementById("cancelBtn");
    const saveBtn = document.getElementById("saveBtn");
    const filePreview = document.getElementById("filePreview");
    const fileDescription = document.getElementById("fileDescription");
    const fileTags = document.getElementById("fileTags");
    const addTagBtn = document.getElementById("addTagBtn");
    const tagsContainer = document.getElementById("tagsContainer");
    const fileSection = document.getElementById("section");
    const fileCategory = document.getElementById("category");
    let currentFileIndex = -1;

    // Auto-format date inputs as dd/mm/yyyy
    const formatDateInput = (input) => {
        if (!input) return;
        input.addEventListener('input', (e) => {
            let val = input.value.replace(/\D/g, ''); // keep digits only
            if (val.length > 8) val = val.slice(0, 8);
            let formatted = '';
            if (val.length > 0) {
                formatted += val.slice(0, 2);
            }
            if (val.length > 2) {
                formatted += '/' + val.slice(2, 4);
            }
            if (val.length > 4) {
                formatted += '/' + val.slice(4, 8);
            }
            input.value = formatted;
        });
    };
    formatDateInput(document.getElementById('globalEventDate'));
    formatDateInput(fileEventDate);

    fetch('/get_portals')
        .then(response => response.json())
        .then(data => {
            const portalSelect = document.getElementById('filePortal');
            const defaultOption = document.createElement('option');
            defaultOption.value = "none";
            defaultOption.textContent = "(No portal)";
            portalSelect.appendChild(defaultOption);
            
            data.portals.forEach(portal => {
                const option = document.createElement('option');
                option.value = portal.id;
                option.textContent = portal.name;
                portalSelect.appendChild(option);
            });
        })
        .catch(error => console.error('Error loading portals:', error));

    fetch('/get_folders')
        .then(response => response.json())
        .then(data => {
            if (data.folders) {
                buildFolderPicker(data.folders, 'globalFolderPicker', 'globalFolder', 'globalFolderTree');
                buildFolderPicker(data.folders, 'fileFolderPicker', 'fileFolder', 'fileFolderTree');
            }
        })
        .catch(error => console.error('Error loading folders:', error));

    function buildFolderPicker(folders, wrapperId, hiddenInputId, treeId) {
        const wrapper = document.getElementById(wrapperId);
        const hiddenInput = document.getElementById(hiddenInputId);
        const treeRoot = document.getElementById(treeId);
        if (!wrapper || !hiddenInput || !treeRoot) return;

        const byId = {};
        folders.forEach(f => { byId[f.id] = { ...f, children: [] }; });
        const roots = [];
        folders.forEach(f => {
            if (f.parent_id && byId[f.parent_id]) {
                byId[f.parent_id].children.push(byId[f.id]);
            } else {
                roots.push(byId[f.id]);
            }
        });

        function renderNodes(nodes, container) {
            nodes.forEach(node => {
                const li = document.createElement('li');
                li.className = 'fp-node';

                const row = document.createElement('div');
                row.className = 'fp-row';
                row.dataset.id = node.id;
                row.dataset.name = node.name;
                if (node.children.length > 0) {
                    const toggle = document.createElement('span');
                    toggle.className = 'fp-toggle';
                    toggle.innerHTML = '<i class="fas fa-plus"></i>'; 
                    toggle.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const childrenEl = li.querySelector(':scope > .fp-children');
                        if (childrenEl) {
                            const isClosed = childrenEl.style.display === 'none';
                            childrenEl.style.display = isClosed ? '' : 'none';
                            toggle.innerHTML = isClosed ? '<i class="fas fa-minus"></i>' : '<i class="fas fa-plus"></i>';
                        }
                    });
                    row.appendChild(toggle);
                } 
                else {
                    const spacer = document.createElement('span');
                    spacer.className = 'fp-toggle-spacer';
                    row.appendChild(spacer);
                }
                const icon = document.createElement('i');
                icon.className = 'far fa-folder fp-icon';
                row.appendChild(icon);
                const name = document.createElement('span');
                name.className = 'fp-name';
                name.textContent = node.name;
                row.appendChild(name);
                row.addEventListener('click', () => selectFolder(wrapper, hiddenInput, node.id, node.name));
                li.appendChild(row);
                if (node.children.length > 0) {
                    const childrenUl = document.createElement('ul');
                    childrenUl.className = 'fp-tree fp-children';
                    childrenUl.style.display = 'none'; 
                    renderNodes(node.children, childrenUl);
                    li.appendChild(childrenUl);
                }

                container.appendChild(li);
            });
        }

        renderNodes(roots, treeRoot);

        wrapper.querySelector('.fp-no-folder').addEventListener('click', () => {
            selectFolder(wrapper, hiddenInput, hiddenInput.id === 'fileFolder' ? 'none' : '', '(No folder)', true);
        });

        wrapper.querySelector('.folder-picker-trigger').addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = wrapper.classList.toggle('open');
            if (isOpen) {
                document.querySelectorAll('.folder-picker-wrapper.open').forEach(w => {
                    if (w !== wrapper) w.classList.remove('open');
                });
            }
        });
    }

    function selectFolder(wrapper, hiddenInput, value, label, isNone = false) {
        hiddenInput.value = value;
        const trigger = wrapper.querySelector('.trigger-label');
        trigger.textContent = label;
        trigger.classList.toggle('selected', !isNone);

        wrapper.querySelectorAll('.fp-row').forEach(r => r.classList.remove('fp-selected'));
        if (!isNone) {
            const target = wrapper.querySelector(`.fp-row[data-id="${value}"]`);
            if (target) {
                target.classList.add('fp-selected');
                const icon = target.querySelector('.fp-icon');
                if (icon) { icon.className = 'far fa-folder-open fp-icon'; }
            }
        }
        wrapper.classList.remove('open');
    }

    document.addEventListener('click', () => {
        document.querySelectorAll('.folder-picker-wrapper.open').forEach(w => w.classList.remove('open'));
    });

    function resetFolderPicker(pickerId, noFolderValue = 'none') {
        const wrapper = document.getElementById(pickerId);
        if (!wrapper) return;
        const hiddenInput = wrapper.querySelector('input[type="hidden"]');
        if (hiddenInput) hiddenInput.value = noFolderValue;
        const trigger = wrapper.querySelector('.trigger-label');
        if (trigger) { trigger.textContent = '(No folder)'; trigger.classList.remove('selected'); }
        wrapper.querySelectorAll('.fp-row').forEach(r => {
            r.classList.remove('fp-selected');
            const icon = r.querySelector('.fp-icon');
            if (icon) icon.className = 'far fa-folder fp-icon';
        });
    }

    function setFolderPicker(pickerId, folderId) {
        const wrapper = document.getElementById(pickerId);
        if (!wrapper) return;
        const hiddenInput = wrapper.querySelector('input[type="hidden"]');
        if (!hiddenInput) return;
        if (!folderId || folderId === 'none' || folderId === '') {
            resetFolderPicker(pickerId, hiddenInput.id === 'fileFolder' ? 'none' : '');
            return;
        }
        const target = wrapper.querySelector(`.fp-row[data-id="${folderId}"]`);
        if (target) {
            selectFolder(wrapper, hiddenInput, folderId, target.dataset.name);
        }
    }

    dropArea.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropArea.classList.add("dragover");
    });

    dropArea.addEventListener("dragleave", () => {
        dropArea.classList.remove("dragover");
    });

    dropArea.addEventListener("drop", (e) => {
        e.preventDefault();
        dropArea.classList.remove("dragover");
        handleFiles([...e.dataTransfer.files]);
    });

    fileInput.addEventListener("change", () => {
        handleFiles([...fileInput.files]);
    });

    const closeModal = () => { modal.classList.remove('active'); };
    closeBtn.addEventListener("click", closeModal);
    cancelBtn.addEventListener("click", closeModal);

    saveBtn.addEventListener("click", () => {
        if (currentFileIndex >= 0 && currentFileIndex < filesToUpload.length) {
            const file = filesToUpload[currentFileIndex];
            const description = fileDescription.value.trim();
            const eventDate = fileEventDate.value;
            const portalId = document.getElementById('filePortal').value;
            const section = fileSection ? fileSection.value : "";
            const category = fileCategory ? fileCategory.value : "";
            const tags = Array.from(tagsContainer.querySelectorAll(".tag"))
                .map(tag => tag.textContent.replace("×", "").trim());
            const folderId = document.getElementById('fileFolder').value;
            const isExclusive = document.getElementById('fileExclusive').checked;
            
            const author = document.getElementById('fileMetaAuthor')?.value.trim() || "";
            const copyright = document.getElementById('fileMetaCopyright')?.value.trim() || "";
            const cooperative = document.getElementById('fileMetaCooperative')?.value.trim() || "";
            const country = document.getElementById('fileMetaCountry')?.value.trim() || "";
            const farmer_consent = document.getElementById('fileMetaFarmerConsent')?.value || "";
            const project_name = document.getElementById('fileMetaProjectName')?.value.trim() || "";
            const region = document.getElementById('fileMetaRegion')?.value.trim() || "";
            const wave = document.getElementById('fileMetaWave')?.value.trim() || "";

            fileDetails[file.name] = {
                description,
                tags,
                eventDate,
                portalId, 
                folderId,
                section,
                category,
                isExclusive,
                metadata: {
                    author,
                    copyright,
                    activity: [...fileMetaArrays.activity],
                    challenge: [...fileMetaArrays.challenge],
                    commodity: [...fileMetaArrays.commodity],
                    cooperative,
                    country,
                    ecosystem_service: [...fileMetaArrays.ecosystem_service],
                    farmer_consent,
                    intervention_project_type: [...fileMetaArrays.intervention_project_type],
                    project_name,
                    region,
                    wave
                }
            };

            updateFileListItem(currentFileIndex, description, tags, eventDate, portalId, folderId, isExclusive);
        }
        closeModal();
    });

    addTagBtn.addEventListener("click", addTag);
    fileTags.addEventListener("keypress", (e) => {
        if (e.key === "Enter") addTag();
    });

    window.addTagFromSelect = function(selectElement) {
        if (selectElement.value) {
            const existingTags = Array.from(tagsContainer.querySelectorAll('.tag'))
                .map(tag => tag.textContent.replace('×', '').trim());
            
            if (!existingTags.includes(selectElement.value)) {
                const tag = document.createElement('span');
                tag.className = 'tag';
                tag.innerHTML = `${selectElement.value}<i class="fas fa-times tag-remove"></i>`;
                
                tag.querySelector('.tag-remove').addEventListener('click', () => { tag.remove(); });
                tagsContainer.appendChild(tag);
            }
            selectElement.selectedIndex = 0;
        }
    };

    window.addTagFromSuggestions = function(selectElement) {
        if (selectElement.value) {
            const existingTags = Array.from(tagsContainer.querySelectorAll('.tag'))
                .map(tag => tag.textContent.replace('×', '').trim());
            
            if (!existingTags.includes(selectElement.value)) {
                const tag = document.createElement('span');
                tag.className = 'tag';
                tag.innerHTML = `${selectElement.value}<i class="fas fa-times tag-remove"></i>`;
                
                tag.querySelector('.tag-remove').addEventListener('click', () => { tag.remove(); });
                tagsContainer.appendChild(tag);
            }
            selectElement.selectedIndex = 0;
        }
    };

    function addTag() {
        const tagText = fileTags.value.trim();
        if (tagText) {
            const tag = document.createElement("span");
            tag.className = "tag";
            tag.innerHTML = `${tagText}<i class="fas fa-times tag-remove"></i>`;
            
            tag.querySelector(".tag-remove").addEventListener("click", () => { tag.remove(); });
            tagsContainer.appendChild(tag);
            fileTags.value = "";
        }
    }

    // extrait a la volee les fichiers d'un zip charge
    async function extractZipFile(zipFile) {
        loadingSpinner.style.display = "block";
        sendBtn.disabled = true;
        msg.textContent = "Extracting ZIP file...";
        
        try {
            const zip = new JSZip();
            const zipData = await zip.loadAsync(zipFile);
            const extractedFiles = [];
            const filePromises = [];
            
            zip.forEach((relativePath, zipEntry) => {
                if (!zipEntry.dir) { 
                    filePromises.push(
                        zipEntry.async("blob").then(blob => {
                            const extractedFile = new File([blob], zipEntry.name, {
                                type: blob.type,
                                lastModified: Date.now()
                            });
                            extractedFiles.push(extractedFile);
                        })
                    );
                }
            });
            
            await Promise.all(filePromises);
            return extractedFiles;
        } finally {
            loadingSpinner.style.display = "none";
            sendBtn.disabled = false;
            msg.textContent = "";
        }
    }

    // gere la reception et la pre-validation des fichiers
    async function handleFiles(newFiles) {
        const warningDiv = document.getElementById("warning");
        let duplicateDetected = false;
        let forbiddenExtensionDetected = false;
        const forbiddenExtensions = ['.heic', '.thm', '.emf'];

        for (const file of newFiles) {
            const fileExt = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
            
            if (forbiddenExtensions.includes(fileExt)) {
                forbiddenExtensionDetected = true;
                continue;
            }

            if (fileExt === '.zip') {
                try {
                    const zipFiles = await extractZipFile(file);
                    for (const zipFile of zipFiles) {
                        const zipFileExt = zipFile.name.slice(zipFile.name.lastIndexOf('.')).toLowerCase();
                        if (!forbiddenExtensions.includes(zipFileExt)) {
                            const alreadyExists = filesToUpload.some(existing => existing.name === zipFile.name);
                            if (!alreadyExists) {
                                filesToUpload.push(zipFile);
                                openFileDetailsModal(filesToUpload.length - 1);
                            } 
                            else {
                                duplicateDetected = true;
                            }
                        } 
                        else {
                            forbiddenExtensionDetected = true;
                        }
                    }
                } catch (error) {
                    console.error("Error extracting ZIP file:", error);
                    warningDiv.textContent = "⚠️ Error extracting ZIP file. Please check the file and try again.";
                    setTimeout(() => { warningDiv.textContent = ""; }, 5000);
                }
                continue;
            }

            const alreadyExists = filesToUpload.some(existing => existing.name === file.name);
            if (!alreadyExists) {
                filesToUpload.push(file);
                openFileDetailsModal(filesToUpload.length - 1);
            } else {
                duplicateDetected = true;
            }
        }

        if (duplicateDetected) {
            warningDiv.textContent = "⚠️ Some files were already added";
            setTimeout(() => { warningDiv.textContent = ""; }, 3000);
        }

        if (forbiddenExtensionDetected) {
            warningDiv.textContent = "⚠️ .heic, .thm, and .emf formats are not accepted. Please convert these files to a suitable format before uploading.";
            setTimeout(() => { warningDiv.textContent = ""; }, 7000);
        }

        renderFileList();
    }

    // ouvre le modal pour edit les details d'un fichier
    function openFileDetailsModal(index) {
        if (index >= 0 && index < filesToUpload.length) {
            currentFileIndex = index;
            const file = filesToUpload[index];
            fileDescription.value = "";
            tagsContainer.innerHTML = "";
            fileTags.value = "";
            document.getElementById('filePortal').value = "none";
            resetFolderPicker('fileFolderPicker', 'none');
            if (fileSection) fileSection.value = "";
            if (fileCategory) fileCategory.value = "";
            fileEventDate.value = "";
            
            // Reset individual file metadata inputs and arrays
            document.getElementById('fileMetaAuthor').value = "";
            document.getElementById('fileMetaCopyright').value = "";
            document.getElementById('fileMetaCooperative').value = "";
            document.getElementById('fileMetaCountry').value = "";
            document.getElementById('fileMetaFarmerConsent').value = "";
            document.getElementById('fileMetaProjectName').value = "";
            document.getElementById('fileMetaRegion').value = "";
            document.getElementById('fileMetaWave').value = "";
            
            ['activity', 'challenge', 'commodity', 'ecosystem_service', 'intervention_project_type'].forEach(key => {
                fileMetaArrays[key] = [];
                renderMetaPills('file', key);
            });
            
            if (file.type.startsWith("image/")) {
                const reader = new FileReader();
                reader.onload = (e) => { filePreview.src = e.target.result; };
                reader.readAsDataURL(file);
            } 
            else {
                filePreview.src = "";
                filePreview.alt = "No preview available";
            }
            
            if (fileDetails[file.name]) {
                fileDescription.value = fileDetails[file.name].description || "";
                fileEventDate.value = fileDetails[file.name]?.eventDate || "";
                
                if(fileDetails[file.name].portalId) {
                    document.getElementById('filePortal').value = fileDetails[file.name].portalId;
                }
                
                if(fileDetails[file.name].folderId) {
                    setFolderPicker('fileFolderPicker', fileDetails[file.name].folderId);
                }

                if (fileSection && fileDetails[file.name].section) fileSection.value = fileDetails[file.name].section;
                if (fileCategory && fileDetails[file.name].category) fileCategory.value = fileDetails[file.name].category;
                document.getElementById('fileExclusive').checked = fileDetails[file.name].isExclusive || false;
                
                (fileDetails[file.name].tags || []).forEach(tag => {
                    const tagEl = document.createElement("span");
                    tagEl.className = "tag";
                    tagEl.innerHTML = `${tag}<i class="fas fa-times tag-remove"></i>`;
                    tagEl.querySelector(".tag-remove").addEventListener("click", () => { tagEl.remove(); });
                    tagsContainer.appendChild(tagEl);
                });

                if (fileDetails[file.name].metadata) {
                    const detailsMeta = fileDetails[file.name].metadata;
                    document.getElementById('fileMetaAuthor').value = detailsMeta.author || "";
                    document.getElementById('fileMetaCopyright').value = detailsMeta.copyright || "";
                    document.getElementById('fileMetaCooperative').value = detailsMeta.cooperative || "";
                    document.getElementById('fileMetaCountry').value = detailsMeta.country || "";
                    document.getElementById('fileMetaFarmerConsent').value = detailsMeta.farmer_consent || "";
                    document.getElementById('fileMetaProjectName').value = detailsMeta.project_name || "";
                    document.getElementById('fileMetaRegion').value = detailsMeta.region || "";
                    document.getElementById('fileMetaWave').value = detailsMeta.wave || "";
                    
                    ['activity', 'challenge', 'commodity', 'ecosystem_service', 'intervention_project_type'].forEach(key => {
                        fileMetaArrays[key] = detailsMeta[key] ? [...detailsMeta[key]] : [];
                        renderMetaPills('file', key);
                    });
                }
            }
            
            modal.classList.add('active');
        }
    }

    function updateFileListItem(index, description, tags, eventDate, portalId, folderId, isExclusive) {
        const listItems = fileList.querySelectorAll("li");
        if (index >= 0 && index < listItems.length) {
            const fileNameContainer = listItems[index].querySelector(".file-name-container");
            fileNameContainer.querySelectorAll('.status-icon').forEach(i => i.remove());
            if (description) {
                const descIcon = document.createElement("span");
                descIcon.className = "status-icon";
                descIcon.innerHTML = '<i class="fas fa-align-left text-muted"></i>';
                descIcon.title = "Description added";
                fileNameContainer.insertBefore(descIcon, fileNameContainer.firstChild);
            }
            
            if (tags && tags.length > 0) {
                const tagsIcon = document.createElement("span");
                tagsIcon.className = "status-icon";
                tagsIcon.innerHTML = '<i class="fas fa-tags text-muted"></i>';
                tagsIcon.title = "Tags added";
                fileNameContainer.insertBefore(tagsIcon, fileNameContainer.firstChild);
            }
            
            if (portalId && portalId !== "none") {
                const portalIcon = document.createElement("span");
                portalIcon.className = "status-icon";
                portalIcon.innerHTML = '<i class="fas fa-globe text-muted"></i>';
                portalIcon.title = "Will be added to a portal";
                fileNameContainer.insertBefore(portalIcon, fileNameContainer.firstChild);
            }
            if (folderId && folderId !== "none") {
                const folderIcon = document.createElement("span");
                folderIcon.className = "status-icon";
                folderIcon.innerHTML = '<i class="far fa-folder-open text-muted"></i>';
                folderIcon.title = "Assigned to a folder";
                fileNameContainer.insertBefore(folderIcon, fileNameContainer.firstChild);
            }
            if (isExclusive) {
                const exclusiveIcon = document.createElement("span");
                exclusiveIcon.className = "status-icon";
                exclusiveIcon.innerHTML = '<i class="fas fa-crown" style="color: #eab308;"></i>';
                exclusiveIcon.title = "Exclusive file";
                fileNameContainer.insertBefore(exclusiveIcon, fileNameContainer.firstChild);
            }
        }
    }

    // render la liste des fichiers en attente d'upload
    function renderFileList() {
        fileList.innerHTML = "";

        filesToUpload.forEach((file, index) => {
            const li = document.createElement("li");
            
            const fileContainer = document.createElement("span");
            fileContainer.className = "file-name-container";

            const fileIcon = document.createElement("i");
            fileIcon.className = file.type.startsWith("image/") ? "fas fa-image text-muted" : "fas fa-file text-muted";
            fileIcon.style.marginRight = "8px";
            
            const fileName = document.createElement("span");
            fileName.textContent = file.name;

            const actionsDiv = document.createElement("div");

            const editBtn = document.createElement("button");
            editBtn.innerHTML = '<i class="fas fa-pen"></i>';
            editBtn.className = "action-btn edit-btn";
            editBtn.onclick = () => openFileDetailsModal(index);

            const removeBtn = document.createElement("button");
            removeBtn.innerHTML = '<i class="fas fa-trash"></i>';
            removeBtn.className = "action-btn remove-btn";
            removeBtn.onclick = () => {
                filesToUpload.splice(index, 1);
                delete fileDetails[file.name];
                renderFileList();
            };

            fileContainer.appendChild(fileIcon);
            fileContainer.appendChild(fileName);

            if (index >= MAX_FILES) {
                li.classList.add("invalid");
                const note = document.createElement("span");
                note.className = "file-note";
                note.textContent = " (Max reached)";
                fileContainer.appendChild(note);
            }

            actionsDiv.appendChild(editBtn);
            actionsDiv.appendChild(removeBtn);

            li.appendChild(fileContainer);
            li.appendChild(actionsDiv);
            fileList.appendChild(li);

            if (fileDetails[file.name]) {
                updateFileListItem(index, fileDetails[file.name].description, fileDetails[file.name].tags, fileDetails[file.name].eventDate, fileDetails[file.name].portalId, fileDetails[file.name].folderId, fileDetails[file.name].isExclusive);
            }
        });

        updateMessageAndButton();
    }

    function updateMessageAndButton() {
        const validFiles = filesToUpload.slice(0, MAX_FILES);
        const tooMany = filesToUpload.length > MAX_FILES;

        if (validFiles.length > 0 && !tooMany) {
            msg.className = "message success";
            msg.textContent = `${validFiles.length} file(s) ready to be sent.`;
            sendBtn.disabled = false;
        } 
        else if (validFiles.length > 0 && tooMany) {
            msg.className = "message error";
            msg.textContent = `⚠️ You can upload a maximum of ${MAX_FILES} files. Remove ${filesToUpload.length - MAX_FILES} file(s).`;
            sendBtn.disabled = true;
        } 
        else {
            msg.className = "message";
            msg.textContent = "";
            sendBtn.disabled = true;
        }
    }

    sendBtn.addEventListener("click", async () => {
        const filesToSend = filesToUpload.slice(0, MAX_FILES);
        if (filesToSend.length === 0) return;
        
        const gDesc = document.getElementById('globalDescription')?.value.trim() || "";
        const gSection = document.getElementById('globalSection')?.value || "";
        const gCategory = document.getElementById('globalCategory')?.value || "";
        const gEventDate = document.getElementById('globalEventDate')?.value || "";
        const gPortal = document.getElementById('globalPortal')?.value || "";
        const gFolder = document.getElementById('globalFolder')?.value || "";
        const gExclusive = document.getElementById('globalExclusive')?.checked || false;
        const gTagsRaw = document.getElementById('globalTags')?.value || "";
        const gTagsArray = gTagsRaw.split(',').map(t => t.trim()).filter(t => t.length > 0);

        const gCopyright = document.getElementById('globalMetaCopyright')?.value.trim() || "";
        const gCooperative = document.getElementById('globalMetaCooperative')?.value.trim() || "";
        const gCountry = document.getElementById('globalMetaCountry')?.value.trim() || "";
        const gFarmerConsent = document.getElementById('globalMetaFarmerConsent')?.value || "";
        const gProjectName = document.getElementById('globalMetaProjectName')?.value.trim() || "";
        const gRegion = document.getElementById('globalMetaRegion')?.value.trim() || "";
        const gWave = document.getElementById('globalMetaWave')?.value.trim() || "";

        const isValidDate = (dateStr) => {
            if (!dateStr) return false;
            const reg = /^(\d{2})\/(\d{2})\/(\d{4})$/;
            if (!reg.test(dateStr)) return false;
            const parts = dateStr.match(reg);
            const day = parseInt(parts[1], 10);
            const month = parseInt(parts[2], 10);
            const year = parseInt(parts[3], 10);
            if (month < 1 || month > 12) return false;
            if (day < 1 || day > 31) return false;
            if ([4, 6, 9, 11].includes(month) && day > 30) return false;
            if (month === 2) {
                const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
                if (isLeap && day > 29) return false;
                if (!isLeap && day > 28) return false;
            }
            return true;
        };

        for (const file of filesToSend) {
            const details = fileDetails[file.name] || {};
            const finalEventDate = details.eventDate || gEventDate;
            
            const detailsMeta = details.metadata || {};
            const finalCountry = detailsMeta.country || gCountry;
            const finalRegion = detailsMeta.region || gRegion;
            const finalProjectName = detailsMeta.project_name || gProjectName;

            const isSuperAdmin = (isAdmin || userRole === 'admin');

            if (!isSuperAdmin) {
                // For non-super-admins, country, region and project name are strictly mandatory
                if (!finalCountry) {
                    msg.className = "message error";
                    msg.innerHTML = `<i class="fas fa-exclamation-circle"></i> File "${file.name}" is missing the Country (mandatory).`;
                    return;
                }
                if (!finalRegion) {
                    msg.className = "message error";
                    msg.innerHTML = `<i class="fas fa-exclamation-circle"></i> File "${file.name}" is missing the Region (mandatory).`;
                    return;
                }
                if (!finalProjectName) {
                    msg.className = "message error";
                    msg.innerHTML = `<i class="fas fa-exclamation-circle"></i> File "${file.name}" is missing the Project Name (mandatory).`;
                    return;
                }
            }

            // For everyone, if Event Date is filled, validate its format to avoid server-side crash
            if (finalEventDate && !isValidDate(finalEventDate)) {
                msg.className = "message error";
                msg.innerHTML = `<i class="fas fa-exclamation-circle"></i> File "${file.name}" has an invalid Event Date format. Please use dd/mm/yyyy.`;
                return;
            }
        }

        loadingSpinner.style.display = "block";
        sendBtn.disabled = true;
        msg.className = "message";
        
        let successCount = 0;
        let errors = [];
        const uploadedFileNames = [];

        for (let i = 0; i < filesToSend.length; i++) {
            const file = filesToSend[i];
            msg.textContent = `Uploading file ${i + 1} of ${filesToSend.length}: ${file.name}...`;

            const formData = new FormData();
            formData.append("files", file);
            
            const details = fileDetails[file.name] || {};
            const finalDesc = details.description || gDesc;
            const finalSection = details.section || gSection || "General";
            const finalCategory = details.category || gCategory || "General";
            const finalPortal = (details.portalId && details.portalId !== "none") ? details.portalId : gPortal;
            const finalFolder = (details.folderId && details.folderId !== "none") ? details.folderId : gFolder;
            const finalExclusive = details.isExclusive !== undefined ? details.isExclusive : gExclusive;
            const finalEventDate = details.eventDate || gEventDate;
            let finalTags = [];
            
            if (details.tags && details.tags.length > 0) {
                finalTags = [...new Set([...details.tags, ...gTagsArray])]; 
            } else {
                finalTags = gTagsArray;
            }
            
            formData.append("descriptions", finalDesc);
            formData.append("tags", JSON.stringify(finalTags));
            
            let formattedDate = "";
            if (finalEventDate) {
                formattedDate = finalEventDate.replace(/\//g, '-');
            }
            
            formData.append("date_events", formattedDate);
            formData.append("portal_ids", finalPortal);
            formData.append("sections", finalSection);
            formData.append("categories", finalCategory);
            formData.append("folder_ids", finalFolder);
            formData.append("is_exclusives", finalExclusive);

            const detailsMeta = details.metadata || {};
            const finalMetadata = {
                author: detailsMeta.author || "",
                copyright: detailsMeta.copyright || gCopyright,
                activity: (detailsMeta.activity && detailsMeta.activity.length > 0) ? detailsMeta.activity : globalMetaArrays.activity,
                challenge: (detailsMeta.challenge && detailsMeta.challenge.length > 0) ? detailsMeta.challenge : globalMetaArrays.challenge,
                commodity: (detailsMeta.commodity && detailsMeta.commodity.length > 0) ? detailsMeta.commodity : globalMetaArrays.commodity,
                cooperative: detailsMeta.cooperative || gCooperative,
                country: detailsMeta.country || gCountry,
                ecosystem_service: (detailsMeta.ecosystem_service && detailsMeta.ecosystem_service.length > 0) ? detailsMeta.ecosystem_service : globalMetaArrays.ecosystem_service,
                farmer_consent: detailsMeta.farmer_consent || gFarmerConsent,
                intervention_project_type: (detailsMeta.intervention_project_type && detailsMeta.intervention_project_type.length > 0) ? detailsMeta.intervention_project_type : globalMetaArrays.intervention_project_type,
                project_name: detailsMeta.project_name || gProjectName,
                region: detailsMeta.region || gRegion,
                wave: detailsMeta.wave || gWave
            };
            
            formData.append("metadata", JSON.stringify(finalMetadata));

            try {
                const response = await fetch('/upload', {
                    method: "POST",
                    body: formData
                });
                if (!response.ok) {
                    throw new Error(`Server error: ${response.status}`);
                }
                const result = await response.json();
                if (result.status === "success") {
                    successCount++;
                    uploadedFileNames.push(file.name);
                } else {
                    throw new Error(result.message || "Upload failed");
                }
            } catch (err) {
                console.error(`Error uploading ${file.name}:`, err);
                errors.push(`${file.name}: ${err.message}`);
            }
        }

        loadingSpinner.style.display = "none";
        
        if (errors.length === 0) {
            filesToUpload = [];
            fileDetails = {};
            renderFileList();
            msg.className = "message success";
            msg.innerHTML = '<i class="fas fa-check-circle"></i> All files uploaded successfully!';
            setTimeout(() => { window.location.href = '/'; }, 1500);
        } 
        else {
            msg.className = "message error";
            msg.innerHTML = `<i class="fas fa-exclamation-circle"></i> Uploaded ${successCount} of ${filesToSend.length} files. Errors:<br>${errors.join('<br>')}`;
            // Supprimer uniquement les fichiers qui ont été uploadés avec succès de la file d'attente
            filesToUpload = filesToUpload.filter(file => !uploadedFileNames.includes(file.name));
            renderFileList();
        }
    });
});