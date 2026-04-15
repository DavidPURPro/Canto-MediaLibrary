document.addEventListener('DOMContentLoaded', () => {
    initProfileAvatar();
    initHeaderBubbles();
    initStaggeredReveal();
    setupEventListeners();
    setupModals();
});

function initProfileAvatar() {
    const avatarBtn = document.getElementById('profileBtn');
    if (!avatarBtn) return;

    const email = avatarBtn.getAttribute('data-user-email');
    const isAdmin = avatarBtn.getAttribute('data-is-admin') === 'true';

    let initials = "??";
    if (email) {
        const namePart = email.split('@')[0];
        const parts = namePart.split('.');
        if (parts.length >= 2) {
            initials = parts[0][0].toUpperCase() + parts[parts.length - 1][0].toUpperCase();
        } else {
            initials = parts[0].substring(0, 2).toUpperCase();
        }
    }
    avatarBtn.textContent = initials;

    if (isAdmin) {
        avatarBtn.classList.add('is-admin');
    } else {
        let hash = 0;
        for (let i = 0; i < email.length; i++) {
            hash = email.charCodeAt(i) + ((hash << 5) - hash);
        }
        const color = `hsl(${Math.abs(hash) % 360}, 45%, 50%)`;
        avatarBtn.style.backgroundColor = color;
    }
}

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

    if (portalForm) {
        portalForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const submitBtn = this.querySelector('.btn-primary-confirm');
            const originalText = submitBtn.textContent;
            submitBtn.textContent = 'Creating...';
            submitBtn.disabled = true;

            const portalData = {
                name: document.getElementById('portalName').value.trim(),
                access: document.getElementById('portalAccess').value || 'Public'
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
                } else {
                    alert('Error: ' + data.message);
                    submitBtn.textContent = originalText;
                    submitBtn.disabled = false;
                }
            });
        });
    }

    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', () => {
            if (!portalToDeleteId) return;
            fetch(`/delete_portal/${portalToDeleteId}`, { method: 'POST' })
                .then(() => window.location.reload());
        });
    }
}

window.prepareDelete = (id, name) => {
    portalToDeleteId = id;
    document.getElementById('portalToDeleteName').textContent = name;
    document.getElementById('deletePortalModal').classList.add('active');
};

window.closeDeleteModal = () => {
    document.getElementById('deletePortalModal').classList.remove('active');
};