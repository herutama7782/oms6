
// Main application entry point
// FIX: Firebase imports are removed. The compat library loaded in index.html creates a global `firebase` object.

// Import all modules
import * as audio from './audio.js';
import * as db from './db.js';
import * as ui from './ui.js';
import * as product from './product.js';
import * as cart from './cart.js';
import * as report from './report.js';
import * as contact from './contact.js';
import * as settings from './settings.js';
import * as peripherals from './peripherals.js';
import * as sync from './sync.js';
import { loadDashboard, checkDashboardRefresh } from './ui.js';


// --- GLOBAL STATE ---
// Central state object to avoid complex module dependencies
window.app = {
    db: null,
    cart: { items: [], fees: [], customerId: null, customerName: null },
    currentImageData: null,
    currentEditImageData: null,
    currentStoreLogoData: null,
    currentPage: 'dashboard',
    confirmCallback: null,
    html5QrCode: null,
    currentReportData: [],
    currentCashierReportData: null,
    dashboardTransactions: [],
    lowStockThreshold: 5,
    isOnline: navigator.onLine,
    isSyncing: false,
    currentReceiptTransaction: null,
    isPrinterReady: false,
    isScannerReady: false,
    isChartJsReady: false,
    salesChartInstance: null,
    scanCallback: null,
    currentPinInput: "",
    lastDashboardLoadDate: null,
    audioContext: null,
    currentContactId: null,
    dueItemsList: [],
    activePopover: null,
    cameraStream: null,
    currentUser: null, // For multi-user support
    firebaseUser: null, // For Firebase auth user,
    onLoginSuccess: null,
    currentReportExpenses: [], // Store fetched expenses for report
    // Pagination & Cache State
    productsCache: [], // All products loaded from DB
    filteredGridProducts: [], // Products currently shown in Grid (filtered by search)
    filteredListProducts: [], // Products currently shown in List (filtered by search/cat)
    gridPage: 1,
    listPage: 1,
    itemsPerPage: 24,
    useExternalScanner: false,
};

// --- GLOBAL FUNCTIONS ---
// Expose functions needed by HTML onclick attributes to the window object
const functions = {
    // audio.js
    initAudioContext: audio.initAudioContext,
    // ui.js
    showPage: ui.showPage,
    handleNavClick: ui.handleNavClick,
    loadDashboard: ui.loadDashboard,
    showConfirmationModal: ui.showConfirmationModal,
    closeConfirmationModal: ui.closeConfirmationModal,
    updateDashboardSummaries: ui.updateDashboardSummaries,
    updateUiForRole: ui.updateUiForRole,
    showToast: ui.showToast,
    formatCurrency: ui.formatCurrency,
    updatePendingBadge: ui.updatePendingBadge,
    executeConfirm: ui.executeConfirm,
    formatReceiptDate: ui.formatReceiptDate,
    getLocalDateString: ui.getLocalDateString,
    // product.js
    loadProductsList: product.loadProductsList,
    loadMoreProductsList: product.loadMoreProductsList, // NEW
    loadMoreProductsGrid: product.loadMoreProductsGrid, // NEW
    showAddProductModal: product.showAddProductModal,
    closeAddProductModal: product.closeAddProductModal,
    previewImage: product.previewImage,
    addProduct: product.addProduct,
    editProduct: product.editProduct,
    closeEditProductModal: product.closeEditProductModal,
    previewEditImage: product.previewEditImage,
    updateProduct: product.updateProduct,
    deleteProduct: product.deleteProduct,
    increaseStock: product.increaseStock,
    decreaseStock: product.decreaseStock,
    showManageCategoryModal: product.showManageCategoryModal,
    closeManageCategoryModal: product.closeManageCategoryModal,
    addNewCategory: product.addNewCategory,
    deleteCategory: product.deleteCategory,
    addWholesalePriceRow: product.addWholesalePriceRow,
    addVariationRow: product.addVariationRow,
    updateMainFieldsState: product.updateMainFieldsState,
    updateTotalStock: product.updateTotalStock,
    addVariationWholesalePriceRow: product.addVariationWholesalePriceRow,
    toggleUnlimitedStock: product.toggleUnlimitedStock,
    showStockHistoryModal: product.showStockHistoryModal,
    closeStockHistoryModal: product.closeStockHistoryModal,
    searchProducts: product.searchProducts,
    toggleLowStockFilter: product.toggleLowStockFilter, // NEW
    toggleExpiringFilter: product.toggleExpiringFilter, // NEW
    toggleAdvancedRetailFields: product.toggleAdvancedRetailFields, // NEW
    // cart.js
    addToCart: cart.addToCart,
    addVariationToCart: cart.addVariationToCart,
    closeVariationSelectionModal: cart.closeVariationSelectionModal,
    updateCartItemQuantity: cart.updateCartItemQuantity,
    clearCart: cart.clearCart,
    showCartModal: cart.showCartModal,
    hideCartModal: cart.hideCartModal,
    showPaymentModal: cart.showPaymentModal,
    closePaymentModal: cart.closePaymentModal,
    handleQuickCash: cart.handleQuickCash,
    completeTransaction: cart.completeTransaction,
    startNewTransaction: cart.startNewTransaction,
    selectPaymentMethod: cart.selectPaymentMethod,
    handleDonationToggle: cart.handleDonationToggle,
    updateCartDisplay: cart.updateCartDisplay,
    holdTransaction: cart.holdTransaction,
    showPendingTransactionsModal: cart.showPendingTransactionsModal,
    closePendingTransactionsModal: cart.closePendingTransactionsModal,
    resumeTransaction: cart.resumeTransaction,
    deletePendingTransaction: cart.deletePendingTransaction,
    searchCustomers: cart.searchCustomers,
    selectCustomer: cart.selectCustomer,
    removeSelectedCustomer: cart.removeSelectedCustomer,
    // report.js
    generateReport: report.generateReport,
    exportReportToCSV: report.exportReportToCSV,
    returnItem: report.returnItem,
    generateCashierReport: report.generateCashierReport,
    closeCashierReportModal: report.closeCashierReportModal,
    showExpenseModal: report.showExpenseModal,
    closeExpenseModal: report.closeExpenseModal,
    showExpenseFormModal: report.showExpenseFormModal,
    closeExpenseFormModal: report.closeExpenseFormModal,
    saveExpense: report.saveExpense,
    deleteExpense: report.deleteExpense,
    // contact.js
    switchContactTab: contact.switchContactTab,
    showContactModal: contact.showContactModal,
    closeContactModal: contact.closeContactModal,
    saveContact: contact.saveContact,
    deleteContact: contact.deleteContact,
    resetContactPoints: contact.resetContactPoints,
    showLedgerModal: contact.showLedgerModal,
    closeLedgerModal: contact.closeLedgerModal,
    showAddLedgerEntryModal: contact.showAddLedgerEntryModal,
    closeAddLedgerEntryModal: contact.closeAddLedgerEntryModal,
    saveLedgerEntry: contact.saveLedgerEntry,
    showLedgerActions: contact.showLedgerActions,
    editLedgerEntry: contact.editLedgerEntry,
    deleteLedgerEntry: contact.deleteLedgerEntry,
    showEditDueDateModal: contact.showEditDueDateModal,
    closeEditDueDateModal: contact.closeEditDueDateModal,
    saveDueDate: contact.saveDueDate,
    viewLedgerFromDueDateModal: contact.viewLedgerFromDueDateModal,
    showDueDateModal: contact.showDueDateModal,
    closeDueDateModal: contact.closeDueDateModal,
    searchContacts: contact.searchContacts,
    // settings.js
    saveStoreSettings: settings.saveStoreSettings,
    previewStoreLogo: settings.previewStoreLogo,
    addFee: settings.addFee,
    deleteFee: settings.deleteFee,
    loadFees: settings.loadFees,
    showFeeSelectionModal: settings.showFeeSelectionModal,
    closeFeeSelectionModal: settings.closeFeeSelectionModal,
    applySelectedFees: settings.applySelectedFees,
    exportData: settings.exportData,
    importData: settings.importData,
    handleImport: settings.handleImport,
    showImportProductsModal: settings.showImportProductsModal,
    closeImportProductsModal: settings.closeImportProductsModal,
    handleProductImport: settings.handleProductImport,
    clearAllData: settings.clearAllData,
    startCountdown: settings.startCountdown,
    resetDonationCounter: settings.resetDonationCounter,
    extendProAccess: settings.extendProAccess,
    // Auth & User Management (from settings.js)
    logout: settings.logout,
    lockScreen: settings.lockScreen,
    showManageUsersModal: settings.showManageUsersModal,
    closeManageUsersModal: settings.closeManageUsersModal,
    showUserFormModal: settings.showUserFormModal,
    closeUserFormModal: settings.closeUserFormModal,
    saveUser: settings.saveUser,
    deleteUser: settings.deleteUser,
    // PIN Management
    handlePinInput: settings.handlePinInput,
    handleInitialPinSetup: settings.handleInitialPinSetup,
    // Firebase Auth functions
    showLoginView: settings.showLoginView,
    showRegisterView: settings.showRegisterView,
    showForgotPasswordView: settings.showForgotPasswordView,
    handleEmailLogin: settings.handleEmailLogin,
    handleGoogleLogin: settings.handleGoogleLogin,
    handleEmailRegister: settings.handleEmailRegister,
    handleForgotPassword: settings.handleForgotPassword,
    togglePasswordVisibility: settings.togglePasswordVisibility,
    // peripherals.js
    openCameraModal: peripherals.openCameraModal,
    closeCameraModal: peripherals.closeCameraModal,
    capturePhoto: peripherals.capturePhoto,
    retakePhoto: peripherals.retakePhoto,
    useCapturedPhoto: peripherals.useCapturedPhoto,
    showScanModal: peripherals.showScanModal,
    scanBarcodeForInput: peripherals.scanBarcodeForInput,
    closeScanModal: peripherals.closeScanModal,
    printReceipt: peripherals.printReceipt,
    testPrint: peripherals.testPrint,
    showPrintHelpModal: peripherals.showPrintHelpModal,
    closePrintHelpModal: peripherals.closePrintHelpModal,
    showPreviewReceiptModal: peripherals.showPreviewReceiptModal,
    closePreviewReceiptModal: peripherals.closePreviewReceiptModal,
    printCashierReport: peripherals.printCashierReport,
    shareReceiptViaWhatsApp: peripherals.shareReceiptViaWhatsApp,
    handleKasirScan: peripherals.handleKasirScan, 
    shareCashierReportViaWhatsApp: peripherals.shareCashierReportViaWhatsApp,
    // sync.js
    syncWithServer: sync.syncWithServer,
};
Object.assign(window, functions);


// --- CONSOLE INTERCEPTION ---
// Filter out specific Firestore connectivity noise and safe-guard against circular structure errors
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

// Safe stringify helper for logging arguments without crashing on circular refs
function safeArgToString(arg) {
    if (typeof arg === 'string') return arg;
    if (!arg) return String(arg);
    
    // Try simple conversion
    try {
        return String(arg);
    } catch (e) {
        return '[Object]';
    }
}

function isFirestoreConnectivityError(args) {
    try {
        const msg = args.map(safeArgToString).join(' ');
        // Check for common offline/network errors from Firestore/Firebase
        return msg.includes('Could not reach Cloud Firestore backend') || 
               msg.includes('Backend didn\'t respond within 10 seconds') ||
               msg.includes('The client will operate in offline mode') ||
               (msg.includes('@firebase/firestore') && msg.includes('connectivity'));
    } catch (e) {
        return false;
    }
}

console.error = function(...args) {
    if (isFirestoreConnectivityError(args)) return;
    try {
        originalConsoleError.apply(console, args);
    } catch (e) {
        // Fallback if logging fails (e.g. circular structure in native console implementation)
        // We log a safe string representation instead
        try {
            const safeArgs = args.map(arg => {
                try {
                    return typeof arg === 'object' ? '[Object/Error]' : String(arg);
                } catch(e) { return '[Unserializable]'; }
            });
            originalConsoleError.apply(console, safeArgs);
        } catch (innerE) {
            // If even that fails, just log a static message
            originalConsoleError("Error logging message (circular structure?)");
        }
    }
};

console.warn = function(...args) {
    if (isFirestoreConnectivityError(args)) return;
    try {
        originalConsoleWarn.apply(console, args);
    } catch (e) {
        try {
            const safeArgs = args.map(arg => {
                try {
                    return typeof arg === 'object' ? '[Object/Error]' : String(arg);
                } catch(e) { return '[Unserializable]'; }
            });
            originalConsoleWarn.apply(console, safeArgs);
        } catch (innerE) {
            originalConsoleWarn("Warning logging failed (circular structure?)");
        }
    }
};

// --- INITIALIZATION ---
async function loadHtmlPartials() {
    try {
        const [pagesRes, modalsRes] = await Promise.all([
            fetch('src/html/pages.html'),
            fetch('src/html/modals.html')
        ]);

        if (!pagesRes.ok || !modalsRes.ok) {
            throw new Error(`Failed to load HTML partials. Pages: ${pagesRes.status}, Modals: ${modalsRes.status}`);
        }

        const pagesHtml = await pagesRes.text();
        const modalsHtml = await modalsRes.text();

        document.getElementById('appContainer').insertAdjacentHTML('beforeend', pagesHtml);
        document.body.insertAdjacentHTML('beforeend', modalsHtml);

    } catch (error) {
        console.error("Error loading HTML partials:", error);
        const loadingOverlay = document.getElementById('loadingOverlay');
        const appContainer = document.getElementById('appContainer');
        if(appContainer) appContainer.innerHTML = '';
        if(loadingOverlay) loadingOverlay.innerHTML = `<div class="p-4 text-center"><p class="text-red-500 font-semibold">Gagal memuat komponen aplikasi.</p><p class="text-sm text-gray-600 mt-2">Silakan periksa koneksi internet Anda dan coba muat ulang halaman.</p></div>`;
        
        if(loadingOverlay) {
             loadingOverlay.classList.remove('opacity-0');
             loadingOverlay.style.display = 'flex';
        }
       
        throw error;
    }
}

async function initializeAppDependencies() {
    await settings.loadSettings();
    await product.populateCategoryDropdowns(['productCategory', 'editProductCategory', 'productCategoryFilter']);
    
    // Setup event listeners that are not onclick
    // UPDATED: Use searchProducts instead of filterProductsInGrid
    document.getElementById('searchProduct')?.addEventListener('input', product.searchProducts);
    // NEW: Handle Enter key for barcode scanner
    document.getElementById('searchProduct')?.addEventListener('keydown', product.handleSearchInputKeydown);
    
    document.getElementById('confirmButton')?.addEventListener('click', ui.executeConfirm);
    document.getElementById('cancelButton')?.addEventListener('click', ui.closeConfirmationModal);
    document.getElementById('cashPaidInput')?.addEventListener('input', cart.updatePaymentChange);
    
    report.setupChartViewToggle();
    peripherals.setupBarcodeGenerator();

    if (window.app.isScannerReady) {
        try {
            window.app.html5QrCode = new Html5Qrcode("qr-reader");
        } catch (e) {
            console.warn("Scanner init warning (safe to ignore if not scanning):", e);
        }
    }

    document.body.addEventListener('click', audio.initAudioContext, { once: true });

    window.addEventListener('online', sync.checkOnlineStatus);
    window.addEventListener('offline', sync.checkOnlineStatus);
    await sync.checkOnlineStatus();

    setInterval(checkDashboardRefresh, 60 * 1000);

    document.addEventListener('click', (e) => {
        if (window.app.activePopover && !window.app.activePopover.contains(e.target) && !e.target.closest('[onclick^="showLedgerActions"]')) {
            contact.closeLedgerActions();
        }
    });

    peripherals.updateFeatureAvailability();
    ui.updatePendingBadge();
}

function listenForAuthStateChanges() {
    // FIX: Use the compat version of onAuthStateChanged
    window.auth.onAuthStateChanged(async (firebaseUser) => {
        const loadingOverlay = document.getElementById('loadingOverlay');
        window.app.firebaseUser = firebaseUser;

        if (firebaseUser) {
            // BUG FIX: Add check to ensure email is verified for persistent sessions.
            if (!firebaseUser.emailVerified && !firebaseUser.isAnonymous) {
                console.log("User email not verified on session load. Forcing to auth screen.");
                
                // Don't sign out automatically, they might be in the process of verifying.
                // Just prevent access to the main app.
                document.getElementById('appContainer').classList.add('hidden');
                document.getElementById('bottomNav').classList.add('hidden');
                document.getElementById('loginModal')?.classList.add('hidden');
                document.getElementById('setDevicePinModal')?.classList.add('hidden');

                loadingOverlay.classList.add('opacity-0');
                setTimeout(() => loadingOverlay.style.display = 'none', 300);
                
                const msg = 'Silakan verifikasi email Anda untuk melanjutkan.';
                settings.showAuthContainer(msg, 'info');
                
                return; // Stop further processing until verified
            }

            // Firebase user is logged in and verified.
            console.log("Firebase user detected:", firebaseUser.uid, "Is Anonymous:", firebaseUser.isAnonymous);
            await settings.initiatePinLoginFlow(firebaseUser);
        } else {
            // Firebase user is not logged in. Show login/register screen.
            console.log("No Firebase user. Showing auth screen.");
            document.getElementById('appContainer').classList.add('hidden');
            document.getElementById('bottomNav').classList.add('hidden');
            // Hide all PIN modals as well
            document.getElementById('loginModal')?.classList.add('hidden');
            document.getElementById('setDevicePinModal')?.classList.add('hidden');

            loadingOverlay.classList.add('opacity-0');
            setTimeout(() => loadingOverlay.style.display = 'none', 300);
            settings.showAuthContainer();
        }
    });
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => {
                console.log('ServiceWorker registration successful:', registration.scope);

                // This logic handles the update flow
                registration.addEventListener('updatefound', () => {
                    const newWorker = registration.installing;
                    if (newWorker) {
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                // New update available
                                const toast = document.getElementById('toast');
                                if (toast) {
                                    toast.innerHTML = `Pembaruan tersedia! <button id="reload-button" class="ml-4 font-bold underline">Muat Ulang</button>`;
                                    toast.classList.add('show');
                                    
                                    document.getElementById('reload-button').onclick = () => {
                                        newWorker.postMessage({ action: 'skipWaiting' });
                                        window.location.reload();
                                    };
                                }
                            }
                        });
                    }
                });
            })
            .catch(err => {
                console.log('ServiceWorker registration failed: ', err);
            });
    }
}


// --- DOMContentLoaded ---
async function waitForLibraries() {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            const missing = [];
            if (!window.firebase) missing.push('Firebase');
            // Ensure sub-modules are loaded too
            else if (!window.firebase.auth || !window.firebase.firestore) missing.push('Firebase (Auth/Firestore)');
            
            if (!window.EscPosEncoder) missing.push('EscPosEncoder');
            if (!window.Html5Qrcode) missing.push('Html5Qrcode');
            if (!window.Chart) missing.push('Chart');
            if (!window.html2canvas) missing.push('html2canvas');
            if (!window.JsBarcode) missing.push('JsBarcode');

            if (missing.length === 0) {
                if (!window.app.isPrinterReady) window.app.isPrinterReady = true;
                if (!window.app.isScannerReady) window.app.isScannerReady = true;
                if (!window.app.isChartJsReady) window.app.isChartJsReady = true;

                console.log('All libraries ready.');
                resolve();
            } else {
                const elapsed = Date.now() - start;
                // Show detail message after 3 seconds
                if (elapsed > 3000) {
                     const loadingOverlay = document.getElementById('loadingOverlay');
                     const loadingText = loadingOverlay?.querySelector('p');
                     if (loadingText) {
                         loadingText.innerHTML = `Memuat aplikasi...<br><span class="text-xs text-orange-500">Menunggu: ${missing.join(', ')}</span>`;
                     }
                }
                // Stop trying after 30 seconds and show error
                if (elapsed > 30000) {
                    const loadingOverlay = document.getElementById('loadingOverlay');
                    if (loadingOverlay) {
                         loadingOverlay.innerHTML = `
                            <div class="p-8 text-center bg-white rounded-2xl shadow-xl max-w-sm mx-auto">
                                <i class="fas fa-exclamation-triangle text-4xl text-red-500 mb-4"></i>
                                <h2 class="text-xl font-bold text-gray-800 mb-2">Gagal Memuat</h2>
                                <p class="text-gray-600 mb-6">Library berikut gagal dimuat: <br><strong>${missing.join(', ')}</strong><br>Pastikan koneksi internet Anda stabil untuk memuat library eksternal.</p>
                                <button onclick="window.location.reload()" class="btn bg-blue-500 text-white w-full py-2 rounded-lg font-semibold shadow-md hover:bg-blue-600 transition">
                                    Muat Ulang
                                </button>
                            </div>
                         `;
                    }
                    return; // Stop checking
                }
                setTimeout(check, 100);
            }
        };
        check();
    });
}


window.addEventListener('DOMContentLoaded', async () => {
    try {
        registerServiceWorker(); // Register SW as early as possible
        
        await loadHtmlPartials();
        
        await waitForLibraries();

        const firebaseConfig = {
            apiKey: "AIzaSyBq_BeiCGHKnhFrZvDc0U9BHuZefVaywG0",
            authDomain: "omsetin-45334.firebaseapp.com",
            projectId: "omsetin-45334",
            storageBucket: "omsetin-45334.appspot.com",
            messagingSenderId: "944626340482",
            appId: "1:944626340482:web:61d4a8c5c3c1a3b3e1c2e1"
        };
        
        // FIX: Use global `firebase` object for initialization
        const firebaseApp = firebase.initializeApp(firebaseConfig);
        window.auth = firebase.auth();
        
        // Suppress Firestore connectivity noise by default for SDK logs
        firebase.firestore.setLogLevel('silent');

        try {
            // FIX: Use compat API for firestore and enabling persistence
            window.db_firestore = firebase.firestore();
            await window.db_firestore.enablePersistence();
            console.log('Firestore offline persistence enabled.');
        } catch (err) {
            console.error("Firestore initialization with persistence failed:", err);
            if (err.code === 'failed-precondition') {
                 console.warn('Firestore persistence failed: multiple tabs open or other issue.');
            }
             // Fallback to in-memory persistence
            window.db_firestore = firebase.firestore();
        }

        await db.initDB();
        await initializeAppDependencies();
        listenForAuthStateChanges();

    } catch (error) {
        console.error("Initialization failed:", error);
    }
});
