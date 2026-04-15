document.addEventListener('DOMContentLoaded', function() {
    const particlesContainer = document.getElementById('particles');
    const particleCount = 30;
    
    for (let i = 0; i < particleCount; i++) {
        createParticle();
    }
    
    function createParticle() {
        const particle = document.createElement('div');
        particle.classList.add('particle');
        
        const size = Math.random() * 15 + 5;
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        
        const posX = Math.random() * 100;
        particle.style.left = `${posX}vw`;
        
        const blueShades = [
            'rgba(30, 139, 195, 0.7)',  
            'rgba(52, 152, 219, 0.7)',   
            'rgba(92, 151, 191, 0.7)',  
            'rgba(133, 193, 233, 0.7)', 
            'rgba(174, 214, 241, 0.7)',  
            'rgba(208, 228, 242, 0.7)'   
        ];
        const randomBlue = blueShades[Math.floor(Math.random() * blueShades.length)];
        particle.style.backgroundColor = randomBlue;
        
        const delay = Math.random() * 15;
        particle.style.animationDelay = `${delay}s`;
        
        const duration = 15 + Math.random() * 15;
        particle.style.animationDuration = `${duration}s`;
        
        particlesContainer.appendChild(particle);
        
        setTimeout(() => {
            particle.remove();
            createParticle();
        }, (duration + delay) * 1000);
    }
    
    const loginBtn = document.getElementById('loginButton');
    if (loginBtn) {
        loginBtn.addEventListener('click', function(e) {
            this.style.transform = 'scale(0.98)';
            setTimeout(() => {
                this.style.transform = '';
            }, 150);
        });
    }
});