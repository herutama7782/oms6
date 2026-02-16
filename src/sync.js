import { updateSyncStatusUI } from "./ui.js";
import { showToast, loadDashboard } from "./ui.js";
import { putToDB, getAllFromDB, getSettingFromDB, putSettingToDB, getFromDB } from "./db.js";
import { loadProductsList } from "./product.js";

// MOCK SERVER DATA
const mockServerData = {
    products: [],
    categories: [
        { serverId: 'server_cat_201', name: 'Lainnya', updatedAt: new Date().toISOString() }
    ],
    deleted: {
        products: [],
        categories: []
    }
};

async function mockFetchFromServer(lastSync) {
    console.log('[SYNC] Mock fetching from server since:', lastSync);
    const lastSyncDate = lastSync ? new Date(lastSync) : new Date(0);

    const updates = {
        products: mockServerData.products.filter(p => new Date(p.updatedAt) > lastSyncDate),
        categories: mockServerData.categories.filter(c => new Date(c.updatedAt) > lastSyncDate),
        deleted: mockServerData.deleted
    };

    return new Promise(resolve => setTimeout(() => resolve(updates), 500));
}

export async function checkOnlineStatus() {
    window.app.isOnline = navigator.onLine;
    if (window.app.isOnline) {
        updateSyncStatusUI('synced');
        showToast('Kembali online, sinkronisasi data dimulai.', 2000);
        await syncWithServer();
    } else {
        updateSyncStatusUI('offline');
        showToast('Anda sekarang offline. Perubahan akan disimpan secara lokal.', 3000);
    }
}

export async function queueSyncAction(action, payload) {
    try {
        await putToDB('sync_queue', { action, payload, timestamp: new Date().toISOString() });
        if (window.app.isOnline) {
            syncWithServer();
        }
    } catch (error) {
        console.error('Failed to queue sync action:', error);
        showToast('Gagal menyimpan perubahan untuk sinkronisasi.');
    }
}

export async function syncWithServer(isManual = false) {
    if (!window.app.isOnline) {
        if (isManual) showToast('Anda sedang offline. Sinkronisasi akan dilanjutkan saat kembali online.');
        updateSyncStatusUI('offline');
        return;
    }
    if (window.app.isSyncing) {
        if (isManual) showToast('Sinkronisasi sedang berjalan.');
        return;
    }

    window.app.isSyncing = true;
    updateSyncStatusUI('syncing');

    try {
        const syncQueue = await getAllFromDB('sync_queue');
        if (syncQueue.length > 0) {
             if (isManual) showToast(`Mengirim ${syncQueue.length} perubahan ke server...`);

            for (const task of syncQueue) {
                console.log(`[SYNC] Processing: ${task.action}`, task.payload);
                const response = await new Promise(resolve => setTimeout(() => {
                    console.log(`[SYNC] Mock API call for ${task.action}`);
                    resolve({ success: true, serverId: `server_${Date.now()}`, localId: task.payload.id });
                }, 300));

                if (response.success) {
                    if (task.action.startsWith('CREATE_') && response.serverId && response.localId) {
                        let storeName = '';
                        if (task.action.includes('PRODUCT')) storeName = 'products';
                        if (task.action.includes('CATEGORY')) storeName = 'categories';
                        if (task.action.includes('TRANSACTION')) storeName = 'transactions';
                        if (task.action.includes('FEE')) storeName = 'fees';

                        if (storeName) {
                            const item = await getFromDB(storeName, response.localId);
                            if (item) {
                                item.serverId = response.serverId;
                                await putToDB(storeName, item);
                            }
                        }
                    }
                    
                    const tx = window.app.db.transaction('sync_queue', 'readwrite');
                    tx.objectStore('sync_queue').delete(task.id);
                } else {
                    console.error(`[SYNC] Failed to process task ${task.id}:`, response.error);
                    throw new Error(`API call failed for action: ${task.action}`);
                }
            }
        }

        if (isManual) showToast('Menerima pembaruan dari server...');
        const lastSync = await getSettingFromDB('lastSync');
        const serverUpdates = await mockFetchFromServer(lastSync);

        console.log('[SYNC] Received from mock server:', serverUpdates);

        if (serverUpdates.products.length > 0 || serverUpdates.categories.length > 0 || serverUpdates.deleted.products.length > 0 || serverUpdates.deleted.categories.length > 0) {
            
            const localProducts = await getAllFromDB('products');
            const localCategories = await getAllFromDB('categories');

            const productServerIdMap = new Map(localProducts.filter(p => p.serverId).map(p => [p.serverId, p]));
            const categoryServerIdMap = new Map(localCategories.filter(c => c.serverId).map(c => [c.serverId, c]));

            const tx = window.app.db.transaction(['products', 'categories'], 'readwrite');
            const productStore = tx.objectStore('products');
            const categoryStore = tx.objectStore('categories');

            let changesMade = false;

            for (const serverProduct of serverUpdates.products) {
                const localProduct = productServerIdMap.get(serverProduct.serverId);
                if (localProduct) {
                    if (!localProduct.updatedAt || new Date(serverProduct.updatedAt) > new Date(localProduct.updatedAt)) {
                        Object.assign(localProduct, serverProduct, { id: localProduct.id });
                        productStore.put(localProduct);
                        changesMade = true;
                    }
                } else {
                    const { id, ...productToAdd } = serverProduct; 
                    productStore.put(productToAdd);
                    changesMade = true;
                }
            }

            for (const serverCategory of serverUpdates.categories) {
                const localCategory = categoryServerIdMap.get(serverCategory.serverId);
                if (localCategory) {
                    if (!localCategory.updatedAt || new Date(serverCategory.updatedAt) > new Date(localCategory.updatedAt)) {
                        Object.assign(localCategory, serverCategory, { id: localCategory.id });
                        categoryStore.put(localCategory);
                        changesMade = true;
                    }
                } else {
                    const { id, ...categoryToAdd } = serverCategory;
                    categoryStore.put(categoryToAdd);
                    changesMade = true;
                }
            }

            for (const serverIdToDelete of serverUpdates.deleted.products) {
                const localProductToDelete = productServerIdMap.get(serverIdToDelete);
                if (localProductToDelete) {
                    productStore.delete(localProductToDelete.id);
                    changesMade = true;
                }
            }

            for (const serverIdToDelete of serverUpdates.deleted.categories) {
                const localCategoryToDelete = categoryServerIdMap.get(serverIdToDelete);
                if (localCategoryToDelete) {
                    categoryStore.delete(localCategoryToDelete.id);
                    changesMade = true;
                }
            }
            
            if (changesMade && isManual) {
                showToast('Data lokal diperbarui dari server.');
            }
        } else {
            console.log('[SYNC] Tidak ada pembaruan dari server.');
        }

        await putSettingToDB({ key: 'lastSync', value: new Date().toISOString() });
        updateSyncStatusUI('synced');
         if (isManual) showToast('Sinkronisasi berhasil!');

    } catch (error) {
        console.error('Sync failed:', error);
        updateSyncStatusUI('error');
         if (isManual) showToast('Sinkronisasi gagal. Silakan coba lagi.');
    } finally {
        window.app.isSyncing = false;
        if (window.app.currentPage === 'dashboard') loadDashboard();
        if (window.app.currentPage === 'produk') loadProductsList();
    }
}
