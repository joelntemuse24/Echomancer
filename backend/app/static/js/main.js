// Toast notification system
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');

    const colors = {
        info: 'bg-primary text-primary-foreground',
        success: 'bg-green-600 text-white',
        error: 'bg-destructive text-white',
        warning: 'bg-yellow-600 text-white'
    };

    toast.className = `${colors[type] || colors.info} px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 animate-slide-in`;
    toast.innerHTML = `
        <span>${message}</span>
        <button onclick="this.parentElement.remove()" class="ml-2 hover:opacity-80">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
        </button>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// Show flash messages from Flask
document.addEventListener('DOMContentLoaded', () => {
    const messages = window.flashMessages || [];
    messages.forEach(([category, message]) => {
        const type = category === 'message' ? 'info' : category;
        showToast(message, type);
    });
});
