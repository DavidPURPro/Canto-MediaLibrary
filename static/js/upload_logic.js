document.addEventListener('DOMContentLoaded', () => {
    const fileEventDate = document.getElementById("fileEventDate");
    const dropArea = document.getElementById("drop-area");
    const fileInput = document.getElementById("fileElem");
    const sendBtn = document.getElementById("sendBtn");
    const msg = document.getElementById("msg");
    const fileList = document.getElementById("fileList");
    const loadingSpinner = document.getElementById("loadingSpinner");
    const MAX_FILES = 7;
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

    fetch('/get_portals_list')
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

    // ── Folder Tree Picker ──────────────────────────────────────────────
    function buildFolderPicker(folders, wrapperId, hiddenInputId, treeId) {
        const wrapper = document.getElementById(wrapperId);
        const hiddenInput = document.getElementById(hiddenInputId);
        const treeRoot = document.getElementById(treeId);
        if (!wrapper || !hiddenInput || !treeRoot) return;

        // Build lookup maps
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

        // "No folder" click
        wrapper.querySelector('.fp-no-folder').addEventListener('click', () => {
            selectFolder(wrapper, hiddenInput, hiddenInput.id === 'fileFolder' ? 'none' : '', '(No folder)', true);
        });

        // Toggle dropdown
        wrapper.querySelector('.folder-picker-trigger').addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = wrapper.classList.toggle('open');
            if (isOpen) {
                // Close all other pickers
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

        // Update selected highlight
        wrapper.querySelectorAll('.fp-row').forEach(r => r.classList.remove('fp-selected'));
        if (!isNone) {
            const target = wrapper.querySelector(`.fp-row[data-id="${value}"]`);
            if (target) {
                target.classList.add('fp-selected');
                // Update icon to open folder
                const icon = target.querySelector('.fp-icon');
                if (icon) { icon.className = 'far fa-folder-open fp-icon'; }
            }
        }
        wrapper.classList.remove('open');
    }

    // Close pickers when clicking outside
    document.addEventListener('click', () => {
        document.querySelectorAll('.folder-picker-wrapper.open').forEach(w => w.classList.remove('open'));
    });

    // Helper to reset a folder picker to "no folder"
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

    // Helper to set a folder picker value programmatically
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
            
            fileDetails[file.name] = {
                description,
                tags,
                eventDate,
                portalId, 
                folderId,
                section,
                category,
                isExclusive
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
                exclusiveIcon.innerHTML = '<i class="fas fa-star" style="color: #eab308;"></i>';
                exclusiveIcon.title = "Exclusive file";
                fileNameContainer.insertBefore(exclusiveIcon, fileNameContainer.firstChild);
            }
        }
    }

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
                updateFileListItem(index, fileDetails[file.name].description, fileDetails[file.name].tags, fileDetails[file.name].eventDate, fileDetails[file.name].portalId, fileDetails[file.name].isExclusive);
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
        const gPortal = document.getElementById('globalPortal')?.value || "";
        const gFolder = document.getElementById('globalFolder')?.value || "";
        const gExclusive = document.getElementById('globalExclusive')?.checked || false;
        const gTagsRaw = document.getElementById('globalTags')?.value || "";
        const gTagsArray = gTagsRaw.split(',').map(t => t.trim()).filter(t => t.length > 0);
        const formData = new FormData();
        const url = `/upload`;
        filesToSend.forEach((file) => {
            formData.append("files", file);
            const details = fileDetails[file.name] || {};
            const finalDesc = details.description || gDesc;
            const finalSection = details.section || gSection;
            const finalCategory = details.category || gCategory;
            const finalPortal = (details.portalId && details.portalId !== "none") ? details.portalId : gPortal;
            const finalFolder = (details.folderId && details.folderId !== "none") ? details.folderId : gFolder;
            const finalExclusive = details.isExclusive !== undefined ? details.isExclusive : gExclusive;
            let finalTags = [];
            if (details.tags && details.tags.length > 0) {
                finalTags = [...new Set([...details.tags, ...gTagsArray])]; 
            } 
            else {
                finalTags = gTagsArray;
            }
            formData.append("descriptions", finalDesc);
            formData.append("tags", JSON.stringify(finalTags));
            
            let formattedDate = "";
            if (details.eventDate) {
                const [year, month, day] = details.eventDate.split('-');
                formattedDate = `${day}-${month}-${year}`;
            }
            formData.append("date_events", formattedDate);
            formData.append("portal_ids", finalPortal);
            formData.append("sections", finalSection);
            formData.append("categories", finalCategory);
            formData.append("folder_ids", finalFolder);
            formData.append("is_exclusives", finalExclusive);
        });

        try {
            loadingSpinner.style.display = "block";
            sendBtn.disabled = true;
            msg.className = "message";
            msg.textContent = "Sending...";
            const response = await fetch(url, {
                method: "POST",
                body: formData
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Server error: ${response.status}`);
            }
            const result = await response.json();
            if (result.status === "success") {
                filesToUpload = [];
                fileDetails = {};
                renderFileList();
                msg.className = "message success";
                msg.innerHTML = '<i class="fas fa-check-circle"></i> Upload successful!';
                setTimeout(() => { window.location.href = '/'; }, 1500);
            } 
            else {
                throw new Error(result.message || "Upload failed");
            }
            
        } catch (error) {
            console.error("Erreur d'upload:", error);
            msg.className = "message error";
            msg.innerHTML = `<i class="fas fa-exclamation-circle"></i> Error: ${error.message || "An error occurred"}`;
        } finally {
            loadingSpinner.style.display = "none";
            if(filesToUpload.slice(0, MAX_FILES).length > 0) sendBtn.disabled = false;
        }
    });
});