document.addEventListener('DOMContentLoaded', function() {
    const particlesContainer = document.getElementById('particles');
    const particleCount = 30;
    
    for (let i = 0; i < particleCount; i++) {
        createParticle(true);
    }
    
    function createParticle(initialLoad = false) {
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
        
        const duration = 15 + Math.random() * 15;
        particle.style.animationDuration = `${duration}s`;
        if (initialLoad) {
            const negativeDelay = -(Math.random() * duration);
            particle.style.animationDelay = `${negativeDelay}s`;
        } else {
            particle.style.animationDelay = '0s';
        }
        
        particlesContainer.appendChild(particle);
        const delayValue = parseFloat(particle.style.animationDelay);
        const timeUntilEnd = (duration + delayValue) * 1000;

        setTimeout(() => {
            particle.remove();
            createParticle(false);
        }, timeUntilEnd);
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