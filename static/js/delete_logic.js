document.addEventListener('DOMContentLoaded', function() {
    const searchButton = document.getElementById('search-button');
    const searchInput = document.getElementById('search-input');

    if (searchButton && searchInput) {
        searchButton.addEventListener('click', searchFiles);
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                searchFiles();
            }
        });
    }
});

function searchFiles() {
    const searchTerm = document.getElementById('search-input').value.trim();
    if (!searchTerm) {
        showError("Please enter a search term");
        return;
    }
    
    const isTagSearch = searchTerm.toLowerCase().startsWith('tag:');
    const searchQuery = isTagSearch ? searchTerm.substring(4).trim() : searchTerm;
    
    if (!searchQuery) {
        showError("Please enter a valid search term");
        return;
    }
    
    const endpoint = isTagSearch 
        ? `/search_file?tag=${encodeURIComponent(searchQuery)}` 
        : `/search_file?filename=${encodeURIComponent(searchQuery)}`;
    
    fetch(endpoint)
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => {
                    throw new Error(err.error || 'Network response was not ok');
                });
            }
            return response.json();
        })
        .then(files => {
            if (files.error) {
                showError(files.error);
            } else {
                displayResults(files);
            }
        })
        .catch(error => {
            console.error('Error:', error);
            showError(error.message || "An error occurred while searching.");
        });
}

function displayResults(files) {
    const resultsContainer = document.getElementById('results-container');
    resultsContainer.innerHTML = '';
    
    if (files.length === 0) {
        resultsContainer.innerHTML = `
            <div class="text-center py-5 text-muted">
                <i class="fas fa-file-excel fa-3x mb-3"></i>
                <h4>No files found</h4>
                <p>Try with other search terms</p>
            </div>
        `;
        return;
    }
    
    files.forEach(file => {
        const fileItem = document.createElement('div');
        fileItem.className = 'card mb-3';
        
        fileItem.innerHTML = `
            <div class="card-body">
                <div class="d-flex align-items-center mb-2">
                    <i class="${getFileIcon(file.name)} file-icon"></i>
                    <h5 class="mb-0">${file.name}</h5>
                </div>
                
                ${file.date_ajout ? `<div class="file-date mb-2">Added On ${file.date_ajout}</div>` : ''}
                ${file.date_event ? `<div class="file-date mb-2">Event Date: ${file.date_event}</div>` : ''}

                ${file.description ? `<div class="file-details mt-2">${file.description}</div>` : ''}
                
                ${file.tags && file.tags.length > 0 ? `
                    <div class="mb-3 mt-2">
                        ${file.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}
                    </div>
                ` : ''}
                
                <div class="file-preview-container mb-3">
                    ${getFilePreview(file)}
                </div>
                
                <form id="delete-form-${file.name.replace(/[^a-z0-9]/gi, '_')}" onsubmit="deleteFile(event, '${file.name}')" class="mt-3 border-top pt-3">
                    <div class="confirmation-check form-check">
                        <input class="form-check-input" type="checkbox" id="confirm-${file.name.replace(/[^a-z0-9]/gi, '_')}" name="confirmation" required>
                        <label class="form-check-label" for="confirm-${file.name.replace(/[^a-z0-9]/gi, '_')}">
                            I confirm that I want to permanently delete this file
                        </label>
                    </div>
                    <input type="hidden" name="filename" value="${file.name}">
                    <button type="submit" class="delete-btn mt-2">
                        <i class="fas fa-trash me-2"></i>Delete
                    </button>
                </form>
                <div id="message-${file.name.replace(/[^a-z0-9]/gi, '_')}" class="alert-message mt-2"></div>
            </div>
        `;
        
        resultsContainer.appendChild(fileItem);
    });
}

function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'fas fa-image';
    if (['pdf'].includes(ext)) return 'fas fa-file-pdf';
    if (['doc', 'docx'].includes(ext)) return 'fas fa-file-word';
    if (['xls', 'xlsx'].includes(ext)) return 'fas fa-file-excel';
    if (['ppt', 'pptx'].includes(ext)) return 'fas fa-file-powerpoint';
    if (['zip', 'rar', '7z'].includes(ext)) return 'fas fa-file-archive';
    return 'fas fa-file';
}

function getFilePreview(file) {
    if (isImage(file.name)) {
        return `<img src="${file.url}" class="file-preview" alt="Aperçu">`;
    } else if (isPDF(file.name)) {
        return `<div class="d-flex align-items-center mt-3">
            <i class="fas fa-file-pdf fa-3x me-3" style="color: #e63946;"></i>
            <span class="text-muted">PDF File - Preview Not Available</span>
        </div>`;
    } else {
        return `<div class="d-flex align-items-center mt-3">
            <i class="${getFileIcon(file.name)} fa-3x me-3" style="color: #4361ee;"></i>
            <span class="text-muted">Preview not available for this file type</span>
        </div>`;
    }
}

function isImage(filename) {
    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    return extensions.some(ext => filename.toLowerCase().endsWith(ext));
}

function isPDF(filename) {
    return filename.toLowerCase().endsWith('.pdf');
}

window.deleteFile = function(event, filename) {
    event.preventDefault();
    
    if (!confirm(`Are you sure you want to permanently delete "${filename}"? This action cannot be undone.`)) {
        return;
    }
    
    const form = event.target;
    const formData = new FormData(form);
    
    fetch('/delete_file', {
        method: 'POST',
        body: formData
    })
    .then(response => {
        if (!response.ok) throw new Error('Network response was not ok');
        return response.json();
    })
    .then(data => {
        const messageDiv = document.getElementById(`message-${filename.replace(/[^a-z0-9]/gi, '_')}`);
        if (data.status === 'success') {
            messageDiv.innerHTML = `<div class="alert alert-success">${data.message}</div>`;
            form.remove();
        } else {
            messageDiv.innerHTML = `<div class="alert alert-danger">${data.message}</div>`;
        }
    })
    .catch(error => {
        console.error('Error:', error);
        document.getElementById(`message-${filename.replace(/[^a-z0-9]/gi, '_')}`).innerHTML = 
            `<div class="alert alert-danger">An error occurred while deleting.</div>`;
    });
}

function showError(message) {
    const resultsContainer = document.getElementById('results-container');
    resultsContainer.innerHTML = `
        <div class="alert alert-danger">
            <i class="fas fa-exclamation-triangle me-2"></i>${message}
        </div>
    `;
}