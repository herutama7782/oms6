


import { applyDefaultFees, reconcileCartFees, loadSettings, checkAccess } from './settings.js';
import { loadProductsGrid, loadProductsList, setLowStockFilter, setExpiringFilter } from './product.js';
import { updateCartFabBadge } from './cart.js';
import { loadContactsPage, checkDueDateNotifications } from './contact.js';
import { getAllFromDB, getSettingFromDB } from './db.js';
import { displaySalesReport } from './report.js';

let isNavigating = false;
let navigationTimeout = null; // Menyimpan ID timeout untuk dibersihkan jika perlu

export function formatCurrency(amount) {
    return Math.round(amount).toLocaleString('id-ID');
}

export function getLocalDateString(dateInput) {
    const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function formatReceiptDate(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const d = date.getDate();
    const m = date.getMonth() + 1;
    const y = date.getFullYear();
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${d}/${m}/${y}, ${h}.${min}.${s}`;
}

export async function updatePendingBadge() {
    const badge = document.getElementById('pendingBadge');
    if (!badge) return;
    try {
        const pendingTxs = await getAllFromDB('pending_transactions');
        const count = pendingTxs.length;
        if (count > 0) {
            badge.textContent = count;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    } catch (error) {
        console.error('Failed to update pending badge:', error);
    }
}

export function updateDashboardDate() {
    const dateEl = document.getElementById('dashboardDate');
    if (dateEl) {
        const today = new Date();
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        dateEl.textContent = today.toLocaleDateString('id-ID', options);
    }
}

export async function updateDashboardSummaries() {
    const contacts = await getAllFromDB('contacts');
    const ledgers = await getAllFromDB('ledgers');
    
    let totalReceivables = 0;
    let totalDebts = 0;

    const balanceMap = new Map();

    ledgers.forEach(entry => {
        const currentBalance = balanceMap.get(entry.contactId) || 0;
        const amount = entry.type === 'debit' ? entry.amount : -entry.amount;
        balanceMap.set(entry.contactId, currentBalance + amount);
    });

    contacts.forEach(contact => {
        const balance = balanceMap.get(contact.id) || 0;
        if (contact.type === 'customer') {
            totalReceivables += balance;
        } else {
            totalDebts += balance;
        }
    });
    
    document.getElementById('totalReceivables').textContent = `Rp ${formatCurrency(totalReceivables)}`;
    document.getElementById('totalDebts').textContent = `Rp ${formatCurrency(totalDebts)}`;
}

async function checkExportReminder() {
    try {
        const reminderEnabled = await getSettingFromDB('exportBackupReminder');
        if (!reminderEnabled) {
            return;
        }

        // Don't show if another modal is open or if not on dashboard
        if (window.app.currentPage !== 'dashboard' || document.querySelector('.fixed.inset-0.bg-black.bg-opacity-50:not(.hidden)')) {
            return;
        }

        const reminderIntervalDays = await getSettingFromDB('exportBackupInterval') || 7;
        const reminderIntervalMillis = reminderIntervalDays * 24 * 60 * 60 * 1000;
        const lastExportDateStr = await getSettingFromDB('lastExportDate');
        
        let shouldRemind = false;
        if (!lastExportDateStr) {
            // Remind if user has made at least a few transactions
            const transactions = await getAllFromDB('transactions');
            if (transactions.length > 5) {
                 shouldRemind = true;
            }
        } else {
            const lastExportDate = new Date(lastExportDateStr);
            if (Date.now() - lastExportDate.getTime() > reminderIntervalMillis) {
                shouldRemind = true;
            }
        }

        // Only show once per session to avoid being annoying
        const reminderShownThisSession = sessionStorage.getItem('exportReminderShown');
        if (reminderShownThisSession) {
            shouldRemind = false;
        }

        if (shouldRemind) {
            sessionStorage.setItem('exportReminderShown', 'true');
            showConfirmationModal(
                'Pengingat Backup Data',
                `Sudah lebih dari ${reminderIntervalDays} hari sejak backup data terakhir. Lakukan backup sekarang untuk menjaga data Anda tetap aman.`,
                () => {
                    showPage('pengaturan');
                    setTimeout(() => {
                        document.getElementById('dataManagementCard')?.scrollIntoView({ behavior: 'smooth' });
                    }, 500);
                },
                'Buka Pengaturan',
                'bg-green-500'
            );
        }
    } catch(e) {
        console.error("Error checking export reminder:", e);
    }
}

// Check for Expiring Products
function checkExpiringProducts(products) {
    const expiringCard = document.getElementById('expiringNotificationCard');
    const expiringCountEl = document.getElementById('expiringCount');
    
    if (!expiringCard || !expiringCountEl) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0); // Start of today
    
    const thirtyDaysFromNow = new Date(today);
    thirtyDaysFromNow.setDate(today.getDate() + 30);

    const expiringProducts = products.filter(p => {
        if (!p.expiryDate) return false;
        const expiry = new Date(p.expiryDate);
        // Include expired (expiry < today) and expiring soon (expiry <= 30 days)
        return expiry <= thirtyDaysFromNow;
    });

    if (expiringProducts.length > 0) {
        expiringCountEl.textContent = expiringProducts.length;
        expiringCard.classList.remove('hidden');
    } else {
        expiringCard.classList.add('hidden');
    }
}

// NEW: Onboarding Logic
async function checkOnboardingStatus() {
    const wizard = document.getElementById('onboardingWizard');
    const banner = document.getElementById('onboardingCompleteBanner');
    const percentEl = document.getElementById('onboardingPercent');
    const progressBar = document.getElementById('onboardingProgressBar');
    
    if (!wizard || !banner) return;

    // Check Step 1: Store Identity
    const storeName = await getSettingFromDB('storeName');
    const storeAddress = await getSettingFromDB('storeAddress');
    const step1Done = storeName && storeAddress && storeName.length > 0 && storeAddress.length > 0;

    // Check Step 2: Products
    const products = await getAllFromDB('products');
    const step2Done = products.length > 0;

    // Check Step 3: Transactions
    const transactions = await getAllFromDB('transactions');
    const step3Done = transactions.length > 0;

    const updateStep = (id, isDone, linkPage) => {
        const el = document.getElementById(id);
        if(el) {
            const icon = el.querySelector('i.far, i.fas');
            if(isDone) {
                // Done state
                el.onclick = null;
                el.classList.remove('hover:bg-white', 'cursor-pointer');
                el.classList.add('opacity-75');
                
                const textSpan = el.querySelector('span');
                textSpan.classList.add('line-through', 'text-gray-500');
                
                icon.className = 'fas fa-check-circle mr-3 text-green-500 text-lg';
            } else {
                // Pending state
                el.onclick = () => window.showPage(linkPage);
                el.classList.add('hover:bg-white', 'cursor-pointer');
                el.classList.remove('opacity-75');
                
                const textSpan = el.querySelector('span');
                textSpan.classList.remove('line-through', 'text-gray-500');
                textSpan.classList.add('text-indigo-800', 'font-medium');
                
                icon.className = 'far fa-circle mr-3 text-indigo-400 text-lg';
            }
        }
    };

    updateStep('step1', step1Done, 'pengaturan');
    updateStep('step2', step2Done, 'produk');
    updateStep('step3', step3Done, 'kasir');

    let completed = 0;
    if(step1Done) completed++;
    if(step2Done) completed++;
    if(step3Done) completed++;
    
    const percentage = Math.round((completed / 3) * 100);

    if (percentEl) percentEl.textContent = `${percentage}%`;
    if (progressBar) progressBar.style.width = `${percentage}%`;

    if (completed === 3) {
        wizard.classList.add('hidden');
        // Check if banner was dismissed
        if (!localStorage.getItem('onboardingBannerDismissed')) {
            banner.classList.remove('hidden');
        } else {
            banner.classList.add('hidden');
        }
    } else {
        wizard.classList.remove('hidden');
        banner.classList.add('hidden');
    }
}

export async function loadDashboard() {
    // GUARD: Jika user sudah pindah halaman, hentikan proses render
    if (window.app.currentPage !== 'dashboard') return;

    updateDashboardDate();
    window.app.lastDashboardLoadDate = getLocalDateString(new Date());

    console.log('Refreshing dashboard stats.');

    const today = new Date();
    const todayString = getLocalDateString(today);
    const monthStart = getLocalDateString(new Date(today.getFullYear(), today.getMonth(), 1));

    const lastDonationResetDateStr = await getSettingFromDB('lastDonationResetDate');
    const lastDonationResetDate = lastDonationResetDateStr ? new Date(lastDonationResetDateStr) : new Date(0);
    
    getAllFromDB('transactions').then(transactions => {
        if (window.app.currentPage !== 'dashboard') return; // Guard again inside promise

        window.app.dashboardTransactions = transactions;
        let todaySales = 0;
        let todayTransactionsCount = 0;
        let monthSales = 0;
        let totalAccumulatedDonation = 0;
        
        transactions.forEach(t => {
            const transactionDate = getLocalDateString(t.date);
            if (transactionDate === todayString) {
                todaySales += t.total;
                todayTransactionsCount++;
            }
            if (transactionDate >= monthStart) {
                monthSales += t.total;
            }
            
            // Calculate accumulated donation since last reset
            if (new Date(t.date) >= lastDonationResetDate) {
                totalAccumulatedDonation += t.donation || 0;
            }
        });
        
        (document.getElementById('todaySales')).textContent = `Rp ${formatCurrency(todaySales)}`;
        (document.getElementById('todayTransactions')).textContent = todayTransactionsCount.toString();
        (document.getElementById('monthSales')).textContent = `Rp ${formatCurrency(monthSales)}`;
        (document.getElementById('totalAllTimeDonation')).textContent = `Rp ${formatCurrency(totalAccumulatedDonation)}`;

        const salesChartCard = document.getElementById('salesChartCard');
        if (transactions.length > 0) {
            displaySalesReport(transactions, 'daily');
            salesChartCard.style.display = 'block';
        } else {
            salesChartCard.style.display = 'none';
        }
    });
    
    getAllFromDB('products').then(products => {
        if (window.app.currentPage !== 'dashboard') return;

        (document.getElementById('totalProducts')).textContent = products.length.toString();
        const lowStockCount = products.filter(p => p.stock > 0 && p.stock <= window.app.lowStockThreshold).length;
        const lowStockEl = document.getElementById('lowStockProducts');
        lowStockEl.textContent = lowStockCount.toString();
        lowStockEl.parentElement?.parentElement?.classList.toggle('animate-pulse', lowStockCount > 0);
        
        // NEW: Check expiration dates
        checkExpiringProducts(products);
    });
    
    checkDueDateNotifications();
    updateDashboardSummaries();
    checkExportReminder();
    
    // NEW: Check onboarding status
    checkOnboardingStatus();

    getSettingFromDB('storeName').then(value => {
        const storeNameEl = document.getElementById('dashboardStoreName');
        if (storeNameEl) {
            storeNameEl.textContent = value || 'OmsetPOS';
        }
    });
    getSettingFromDB('storeAddress').then(value => {
        const storeAddressEl = document.getElementById('dashboardStoreAddress');
        if (storeAddressEl) {
            storeAddressEl.textContent = value || 'Pengaturan toko belum diisi';
        }
    });
    getSettingFromDB('storeLogo').then(value => {
        const logoContainer = document.getElementById('dashboardLogo');
        const logoImg = document.getElementById('dashboardLogoImg');
        if (logoContainer && logoImg && value) {
            logoImg.src = value;
            logoContainer.classList.remove('hidden');
        } else if (logoContainer) {
            logoContainer.classList.add('hidden');
        }
    });
}

export function checkDashboardRefresh() {
    const today = getLocalDateString(new Date());
    if (window.app.currentPage === 'dashboard' && window.app.lastDashboardLoadDate !== today) {
        console.log('Day has changed, refreshing dashboard.');
        loadDashboard();
    }
}

export function showToast(message, duration = 3000) {
    const toast = document.getElementById('toast');
    if (toast) {
        toast.textContent = message;
        toast.classList.add('show');
        setTimeout(() => {
            toast.classList.remove('show');
        }, duration);
    }
}

export function updateSyncStatusUI(status) {
    const syncIcon = document.getElementById('syncIcon');
    const syncText = document.getElementById('syncText');
    if (!syncIcon || !syncText) return;

    syncIcon.classList.remove('fa-spin', 'text-green-500', 'text-red-500', 'text-yellow-500');

    switch (status) {
        case 'syncing':
            syncIcon.className = 'fas fa-sync-alt fa-spin';
            syncText.textContent = 'Menyinkronkan...';
            break;
        case 'synced':
            syncIcon.className = 'fas fa-check-circle text-green-500';
            syncText.textContent = 'Terbaru';
            break;
        case 'offline':
            syncIcon.className = 'fas fa-wifi text-gray-400';
            syncText.textContent = 'Offline';
            break;
        case 'error':
            syncIcon.className = 'fas fa-exclamation-triangle text-red-500';
            syncText.textContent = 'Gagal sinkron';
            break;
        default:
            syncIcon.className = 'fas fa-sync-alt';
            syncText.textContent = 'Siap';
            break;
    }
}

export function updateUiForRole() {
    const user = window.app.currentUser;
    if (!user) return;
    
    const role = user.role;

    // Nav items
    const navProduk = document.querySelector('.nav-item[data-page="produk"]');
    if (navProduk) navProduk.style.display = (role === 'cashier') ? 'none' : 'flex';
    const navLaporan = document.querySelector('.nav-item[data-page="laporan"]');
    if (navLaporan) navLaporan.style.display = 'flex';
    const navKontak = document.querySelector('.nav-item[data-page="kontak"]');
    if (navKontak) navKontak.style.display = (role === 'cashier') ? 'none' : 'flex';
    const navPengaturan = document.querySelector('.nav-item[data-page="pengaturan"]');
    if (navPengaturan) navPengaturan.style.display = (role === 'cashier') ? 'none' : 'flex';
    
    // Settings page items
    const userManagementCard = document.getElementById('userManagementCard');
    if(userManagementCard) userManagementCard.style.display = checkAccess(['owner', 'manager']) ? 'block' : 'none';
    
    const dataManagementCard = document.getElementById('dataManagementCard');
    if(dataManagementCard) dataManagementCard.style.display = checkAccess(['owner', 'manager']) ? 'block' : 'none';
    
    const sessionManagementCard = document.getElementById('sessionManagementCard');
    if(sessionManagementCard) sessionManagementCard.style.display = 'block';

    const clearDataBtn = document.getElementById('clearDataBtn');
    if(clearDataBtn) clearDataBtn.style.display = checkAccess('owner') ? 'block' : 'none';
    
    const fullLogoutBtn = document.getElementById('fullLogoutBtn');
    if (fullLogoutBtn) fullLogoutBtn.style.display = (role === 'owner') ? 'block' : 'none';
    
    const bottomNav = document.getElementById('bottomNav');
    if(bottomNav) bottomNav.classList.remove('hidden');
}

export async function showPage(pageName, options = { force: false, initialTab: null, filterLowStock: false, filterExpiring: false }) {
    const { force, initialTab, filterLowStock, filterExpiring } = options;
    
    // 1. Navigation Lock: Prevent navigation if already navigating
    // This prevents race conditions where multiple pages try to load at once
    if (isNavigating && !force) {
        console.log('Navigation locked. Waiting for transition.');
        return;
    }

    const pagePermissions = {
        'dashboard': ['owner', 'manager', 'cashier'],
        'kasir': ['owner', 'manager', 'cashier'],
        'produk': ['owner', 'manager'],
        'kontak': ['owner', 'manager'],
        'laporan': ['owner', 'manager', 'cashier'],
        'pengaturan': ['owner', 'manager']
    };

    if (!checkAccess(pagePermissions[pageName])) {
        showToast('Akses ditolak.');
        return;
    }

    if (window.app.currentPage === 'kasir' && window.app.cart.items.length > 0 && pageName !== 'kasir' && !force) {
        showConfirmationModal(
            'Keranjang Belum Disimpan',
            'Anda memiliki item di keranjang. Meninggalkan halaman ini akan mengosongkan keranjang. Lanjutkan?',
            async () => {
                window.app.cart = { items: [], fees: [] };
                await applyDefaultFees();
                updateCartFabBadge();
                showPage(pageName, { force: true });
            },
            'Ya, Lanjutkan & Kosongkan',
            'bg-yellow-500' 
        );
        return;
    }

    if (window.app.currentPage === pageName && !filterLowStock && !filterExpiring) return; 
    if (window.app.currentPage === pageName && (filterLowStock || filterExpiring)) {
        if (setLowStockFilter) setLowStockFilter(!!filterLowStock);
        if (setExpiringFilter) setExpiringFilter(!!filterExpiring);
        loadProductsList();
        return;
    }

    // START NAVIGATION
    isNavigating = true;
    
    // 2. Clear any pending transition cleanup to prevent it from hiding the NEW page
    if (navigationTimeout) {
        clearTimeout(navigationTimeout);
        navigationTimeout = null;
    }
    
    // 3. Update current page state IMMEDIATELY so data loaders know where we are
    window.app.currentPage = pageName;

    const transitionDuration = 300;

    const oldPage = document.querySelector('.page.active');
    const newPage = document.getElementById(pageName);
    const cartFab = document.getElementById('cartFab');

    if (!newPage) {
        isNavigating = false;
        return;
    }

    // Update Bottom Nav UI
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const navItem = document.querySelector(`.nav-item[data-page="${pageName}"]`);
    if (navItem) navItem.classList.add('active');

    // Prepare Animation
    newPage.classList.add('page-enter');
    newPage.style.display = 'block'; // Make new page visible for animation start

    if (oldPage) {
        oldPage.classList.add('page-exit');
    }
    
    // Handle FAB
    if (pageName === 'kasir') {
        cartFab.classList.remove('hidden');
    } else {
        cartFab.classList.add('hidden');
    }

    // LOAD DATA (Async but don't await blocking UI thread entirely)
    if (pageName === 'dashboard') {
        loadDashboard();
    } else if (pageName === 'kasir') {
        loadProductsGrid();
        await reconcileCartFees();
        updateCartFabBadge();
        updatePendingBadge();
        const cashierLogoutBtn = document.getElementById('cashierLogoutBtn');
        if (cashierLogoutBtn) {
            cashierLogoutBtn.classList.remove('hidden');
        }
    } else if (pageName === 'produk') {
        if (setLowStockFilter) {
             setLowStockFilter(!!filterLowStock);
        }
        if (setExpiringFilter) {
             setExpiringFilter(!!filterExpiring);
        }
        loadProductsList();
    } else if (pageName === 'kontak') {
        loadContactsPage(initialTab);
    } else if (pageName === 'laporan') {
        const adminView = document.getElementById('adminReportView');
        const cashierView = document.getElementById('cashierReportView');
        if (checkAccess(['owner', 'manager'])) {
            adminView.classList.remove('hidden');
            cashierView.classList.add('hidden');
        } else { // Cashier
            adminView.classList.add('hidden');
            cashierView.classList.remove('hidden');
        }
    } else if (pageName === 'pengaturan') {
        loadSettings();
        window.loadFees();
        if (window.startCountdown) {
            window.startCountdown();
        }
    }

    // EXECUTE ANIMATION
    requestAnimationFrame(() => {
        newPage.classList.remove('page-enter');
        newPage.classList.add('active');

        if (oldPage) oldPage.classList.remove('active');

        // Cleanup after transition
        navigationTimeout = setTimeout(() => {
            if (oldPage) {
                oldPage.classList.remove('page-exit');
                oldPage.style.display = 'none';
            }
            
            // 4. SAFETY CLEANUP: Ensure ONLY the current page is visible
            // This fixes "blank page" issues if rapid clicking messed up the DOM
            document.querySelectorAll('.page').forEach(page => {
                if (page.id !== pageName) {
                    page.style.display = 'none';
                    page.classList.remove('active', 'page-enter', 'page-exit');
                } else {
                    page.style.display = 'block';
                    page.classList.add('active');
                }
            });

            isNavigating = false;
            
            if (pageName === 'kasir') {
                const searchInput = document.getElementById('searchProduct');
                if (searchInput) {
                    setTimeout(() => searchInput.focus(), 50);
                }
            }
        }, transitionDuration);
    });
}

export function handleNavClick(button) {
    const pageName = button.dataset.page;
    if (pageName) {
        showPage(pageName);
    }
}

export function showConfirmationModal(title, message, onConfirm, confirmText = 'OK', confirmClass = 'bg-blue-500', showCancel = true) {
    document.getElementById('confirmationTitle').innerHTML = title;
    document.getElementById('confirmationMessage').innerHTML = message;
    
    const confirmButton = document.getElementById('confirmButton');
    const cancelButton = document.getElementById('cancelButton');
    
    confirmButton.textContent = confirmText;
    
    // Check if onConfirm is effectively 'empty' (for simple info modals)
    const isInfoModal = onConfirm && onConfirm.toString() === '() => {}';

    if (isInfoModal || !showCancel) {
        cancelButton.classList.add('hidden');
        confirmButton.className = `btn text-white w-full py-2 ${confirmClass}`;
    } else {
        cancelButton.classList.remove('hidden');
        confirmButton.className = `btn text-white flex-1 py-2 ${confirmClass}`;
        cancelButton.className = 'btn bg-gray-300 text-gray-700 flex-1 py-2';
    }

    window.app.confirmCallback = onConfirm;
    document.getElementById('confirmationModal').classList.remove('hidden');
}

export function closeConfirmationModal() {
    (document.getElementById('confirmationModal')).classList.add('hidden');
    window.app.confirmCallback = null;
}

export function executeConfirm() {
    if (window.app.confirmCallback) {
        window.app.confirmCallback();
    }
    closeConfirmationModal();
}