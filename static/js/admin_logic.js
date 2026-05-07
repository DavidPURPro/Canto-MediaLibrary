function openModal(id) { 
    document.getElementById(id).classList.add('active'); 
}

function closeModal(id) { 
    document.getElementById(id).classList.remove('active'); 
}

function openEditModal(userId, email) {
    document.getElementById('editUserId').value = userId;
    document.getElementById('editUserEmail').textContent = email;
    openModal('editModal');
}

function openDeleteModal(userId, email) {
    document.getElementById('deleteUserId').value = userId;
    document.getElementById('deleteUserEmail').textContent = email;
    openModal('deleteModal');
}

async function submitForm(e, url, modalId) {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);

    try {
        const response = await fetch(url, {
            method: 'POST',
            body: formData
        });
        
        const result = await response.json();
        
        if (result.status === 'success') {
            alert(result.message);
            window.location.reload(); 
        } 
        else {
            alert("Erreur : " + result.message);
        }
    } catch (error) {
        console.error("Erreur AJAX :", error);
        alert("An error occurred during communication with the server.");
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const addForm = document.getElementById('addForm');
    const editForm = document.getElementById('editForm');
    const deleteForm = document.getElementById('deleteForm');

    if (addForm) addForm.addEventListener('submit', (e) => submitForm(e, '/admin/add_user', 'addModal'));
    if (editForm) editForm.addEventListener('submit', (e) => submitForm(e, '/admin/update_password', 'editModal'));
    if (deleteForm) deleteForm.addEventListener('submit', (e) => submitForm(e, '/admin/delete_user', 'deleteModal'));
    const searchInput = document.getElementById('userSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            const filter = this.value.toLowerCase();
            const rows = document.querySelectorAll('.admin-table tbody tr');

            rows.forEach(row => {
                if (row.cells.length <= 1) return; 
                const email = row.cells[0].textContent.toLowerCase();
                const portal = row.cells[1].textContent.toLowerCase();
                if (email.includes(filter) || portal.includes(filter)) {
                    row.style.display = '';
                } 
                else {
                    row.style.display = 'none';
                }
            });
        });
    }
});