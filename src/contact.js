
import { getAllFromDB, getFromDB, putToDB } from './db.js';
import { queueSyncAction } from './sync.js';

let currentContactTab = 'customer';
let cachedContacts = [];
let currentLedgerContactId = null;
let currentLedgerType = null; // 'debit' or 'credit'
let editingLedgerEntryId = null;
let searchTimeout = null;

export async function loadContactsPage(initialTab) {
    if (initialTab) {
        currentContactTab = initialTab;
    }
    updateTabUI();
    await fetchAndRenderContacts();
}

export function switchContactTab(tab) {
    currentContactTab = tab;
    updateTabUI();
    fetchAndRenderContacts();
}

function updateTabUI() {
    const customerTab = document.getElementById('customerTab');
    const supplierTab = document.getElementById('supplierTab');
    
    if (currentContactTab === 'customer') {
        customerTab.classList.add('active');
        supplierTab.classList.remove('active');
        document.getElementById('customerListContainer').classList.remove('hidden');
        document.getElementById('supplierListContainer').classList.add('hidden');
    } else {
        supplierTab.classList.add('active');
        customerTab.classList.remove('active');
        document.getElementById('supplierListContainer').classList.remove('hidden');
        document.getElementById('customerListContainer').classList.add('hidden');
    }
}

async function fetchAndRenderContacts(query = '') {
    try {
        const allContacts = await getAllFromDB('contacts');
        const ledgers = await getAllFromDB('ledgers');
        
        // Calculate balances
        const balanceMap = new Map();
        ledgers.forEach(entry => {
            const current = balanceMap.get(entry.contactId) || 0;
            // For simplicity in display:
            // Debit (+) adds to balance (Debt/Receivable increases)
            // Credit (-) subtracts from balance (Payment)
            const amount = entry.type === 'debit' ? entry.amount : -entry.amount;
            balanceMap.set(entry.contactId, current + amount);
        });

        cachedContacts = allContacts.map(c => ({
            ...c,
            balance: balanceMap.get(c.id) || 0
        }));

        const filtered = cachedContacts.filter(c => 
            c.type === currentContactTab && 
            (query === '' || 
             c.name.toLowerCase().includes(query.toLowerCase()) || 
             (c.phone && c.phone.includes(query)) ||
             (c.barcode && c.barcode.includes(query)))
        );

        renderContactsList(filtered);
    } catch (e) {
        console.error("Error loading contacts:", e);
        window.showToast("Gagal memuat kontak");
    }
}

export function searchContacts(query) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        fetchAndRenderContacts(query);
    }, 300);
}

function renderContactsList(contacts) {
    const type = currentContactTab;
    const listElId = type === 'customer' ? 'customerList' : 'supplierList';
    const listEl = document.getElementById(listElId);

    if (contacts.length === 0) {
        if(!document.getElementById('searchContactInput').value) {
             listEl.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon"><i class="fas fa-users-slash"></i></div>
                    <h3 class="empty-state-title">Belum Ada Kontak</h3>
                    <p class="empty-state-description">Tambahkan ${type === 'customer' ? 'pelanggan' : 'supplier'} baru untuk mulai melacak hutang/piutang.</p>
                    <button onclick="showContactModal()" class="empty-state-action">
                        <i class="fas fa-plus mr-2"></i>Tambah Kontak
                    </button>
                </div>
            `;
        } else {
            listEl.innerHTML = `<div class="text-center py-4 text-gray-500">Tidak ditemukan kontak yang cocok.</div>`;
        }
        return;
    }
    
    listEl.innerHTML = contacts.map(contact => {
        const balance = contact.balance || 0;
        let balanceHtml = '';
        if (balance !== 0) {
             const balanceColor = type === 'customer' ? 'text-teal-600' : 'text-red-600';
             const balanceLabel = type === 'customer' ? 'Piutang' : 'Hutang';
             if (balance > 0) {
                balanceHtml = `<p class="text-sm font-semibold ${balanceColor}">${balanceLabel}: Rp ${window.formatCurrency(balance)}</p>`;
             } else if (balance < 0) {
                 balanceHtml = `<p class="text-sm font-semibold text-green-600">Deposit: Rp ${window.formatCurrency(Math.abs(balance))}</p>`;
             }
        } else {
            balanceHtml = `<p class="text-sm text-green-600">Lunas</p>`;
        }
        
        const points = contact.points || 0;
        const pointsHtml = type === 'customer' 
            ? `<p class="text-xs text-gray-500 mt-1"><i class="fas fa-star text-yellow-500 mr-1"></i>${points} Poin</p>`
            : '';

        const resetPointsButtonHtml = (type === 'customer' && points > 0)
            ? `<button onclick="event.stopPropagation(); resetContactPoints(${contact.id})" class="btn bg-yellow-100 text-yellow-700 px-3 py-1 text-xs">Reset Poin</button>`
            : '';

        return `
            <div class="card p-4 clickable" onclick="showLedgerModal(${contact.id})">
                <div class="flex justify-between items-start">
                    <div>
                        <h3 class="font-semibold text-lg">${contact.name}</h3>
                        <p class="text-sm text-gray-500"><i class="fas fa-phone mr-2"></i>${contact.phone || '-'}</p>
                    </div>
                    <div class="text-right">
                         ${balanceHtml}
                         ${pointsHtml}
                    </div>
                </div>
                <div class="flex justify-end gap-2 mt-2 pt-2 border-t">
                    ${resetPointsButtonHtml}
                    <button onclick="event.stopPropagation(); showLedgerModal(${contact.id})" class="btn bg-gray-100 text-gray-700 px-3 py-1 text-xs">Riwayat</button>
                    <button onclick="event.stopPropagation(); showContactModal(${contact.id})" class="btn bg-blue-100 text-blue-700 px-3 py-1 text-xs">Edit</button>
                    <button onclick="event.stopPropagation(); deleteContact(${contact.id})" class="btn bg-red-100 text-red-700 px-3 py-1 text-xs">Hapus</button>
                </div>
            </div>
        `;
    }).join('');
}

export function showContactModal(id = null) {
    const modal = document.getElementById('contactModal');
    const title = document.getElementById('contactModalTitle');
    
    // Reset form
    document.getElementById('contactId').value = '';
    document.getElementById('contactName').value = '';
    document.getElementById('contactPhone').value = '';
    document.getElementById('contactBarcode').value = '';
    document.getElementById('contactAddress').value = '';
    document.getElementById('contactNotes').value = '';
    document.getElementById('contactType').value = currentContactTab;
    
    if (id) {
        title.textContent = 'Edit Kontak';
        getFromDB('contacts', id).then(c => {
            if(c) {
                document.getElementById('contactId').value = c.id;
                document.getElementById('contactName').value = c.name;
                document.getElementById('contactPhone').value = c.phone || '';
                document.getElementById('contactBarcode').value = c.barcode || '';
                document.getElementById('contactAddress').value = c.address || '';
                document.getElementById('contactNotes').value = c.notes || '';
                document.getElementById('contactType').value = c.type;
            }
        });
    } else {
        title.textContent = 'Tambah Kontak';
    }
    
    modal.classList.remove('hidden');
}

export function closeContactModal() {
    document.getElementById('contactModal').classList.add('hidden');
}

export async function saveContact() {
    const id = document.getElementById('contactId').value;
    const name = document.getElementById('contactName').value.trim();
    const phone = document.getElementById('contactPhone').value.trim();
    const barcode = document.getElementById('contactBarcode').value.trim();
    const address = document.getElementById('contactAddress').value.trim();
    const notes = document.getElementById('contactNotes').value.trim();
    const type = document.getElementById('contactType').value;

    if (!name) {
        window.showToast('Nama kontak wajib diisi');
        return;
    }

    try {
        const allContacts = await getAllFromDB('contacts');
        
        // Validation: Check for duplicate Name + Phone
        const isDuplicate = allContacts.some(c => {
            if (id && String(c.id) === String(id)) return false;
            const dbName = c.name.toLowerCase();
            const inputName = name.toLowerCase();
            const dbPhone = (c.phone || '').trim();
            if (phone === '') return dbName === inputName && dbPhone === '';
            return dbName === inputName && dbPhone === phone;
        });

        if (isDuplicate) {
            window.showToast('Gagal: Kontak dengan nama dan nomor telepon yang sama sudah ada.');
            return;
        }

        // Validation: Check for duplicate Barcode
        if (barcode) {
            const isBarcodeDuplicate = allContacts.some(c => {
                if (id && String(c.id) === String(id)) return false;
                return c.barcode === barcode;
            });
            
            if (isBarcodeDuplicate) {
                window.showToast('Gagal: Barcode sudah digunakan kontak lain.');
                return;
            }
        }

        const contactData = {
            name,
            phone,
            barcode,
            address,
            notes,
            type,
            updatedAt: new Date().toISOString()
        };

        if (id) {
            contactData.id = parseInt(id);
            // Preserve created date and points
            const oldContact = await getFromDB('contacts', contactData.id);
            if (oldContact) {
                contactData.createdAt = oldContact.createdAt;
                contactData.points = oldContact.points || 0;
            }
            
            await putToDB('contacts', contactData);
            await queueSyncAction('UPDATE_CONTACT', contactData);
            window.showToast('Kontak diperbarui');
        } else {
            contactData.createdAt = new Date().toISOString();
            contactData.points = 0;
            const newId = await putToDB('contacts', contactData);
            await queueSyncAction('CREATE_CONTACT', { ...contactData, id: newId });
            window.showToast('Kontak ditambahkan');
        }

        closeContactModal();
        fetchAndRenderContacts(); // Refresh list

    } catch (error) {
        console.error('Error saving contact:', error);
        window.showToast('Gagal menyimpan kontak.');
    }
}

export function deleteContact(id) {
    window.showConfirmationModal(
        'Hapus Kontak',
        'PERINGATAN: Menghapus kontak akan menghapus juga semua riwayat hutang/piutang terkait. Anda yakin?',
        async () => {
            try {
                // Delete ledgers first
                const ledgers = await getAllFromDB('ledgers', 'contactId', id);
                const txLedger = window.app.db.transaction('ledgers', 'readwrite');
                for (const l of ledgers) {
                    txLedger.objectStore('ledgers').delete(l.id);
                }
                
                // Delete contact
                const contactToDelete = await getFromDB('contacts', id);
                const tx = window.app.db.transaction('contacts', 'readwrite');
                tx.objectStore('contacts').delete(id);
                
                tx.oncomplete = async () => {
                    await queueSyncAction('DELETE_CONTACT', contactToDelete);
                    window.showToast('Kontak dihapus');
                    fetchAndRenderContacts();
                };
            } catch (e) {
                console.error("Delete contact error", e);
                window.showToast('Gagal menghapus kontak');
            }
        },
        'Ya, Hapus',
        'bg-red-500'
    );
}

export async function resetContactPoints(id) {
    window.showConfirmationModal(
        'Reset Poin',
        'Apakah Anda yakin ingin mereset poin pelanggan ini menjadi 0?',
        async () => {
            try {
                const contact = await getFromDB('contacts', id);
                if (contact) {
                    contact.points = 0;
                    contact.updatedAt = new Date().toISOString();
                    await putToDB('contacts', contact);
                    await queueSyncAction('UPDATE_CONTACT', contact);
                    window.showToast('Poin berhasil direset.');
                    fetchAndRenderContacts();
                }
            } catch (e) {
                console.error("Reset points error", e);
                window.showToast('Gagal mereset poin.');
            }
        },
        'Ya, Reset',
        'bg-yellow-500'
    );
}

// --- LEDGER FUNCTIONS ---

export async function showLedgerModal(contactId) {
    currentLedgerContactId = contactId;
    const modal = document.getElementById('ledgerModal');
    const historyList = document.getElementById('ledgerHistory');
    const contactNameEl = document.getElementById('ledgerContactName');
    const contactTypeEl = document.getElementById('ledgerContactType');
    const contactDetailsEl = document.getElementById('ledgerContactDetails');
    const addDebitButton = document.getElementById('addDebitButton');

    try {
        const contact = await getFromDB('contacts', contactId);
        if (!contact) return;

        contactNameEl.textContent = contact.name;
        contactTypeEl.textContent = contact.type === 'customer' ? 'Pelanggan' : 'Supplier';
        
        let details = [];
        if (contact.phone) details.push(`<i class="fas fa-phone mr-1"></i> ${contact.phone}`);
        if (contact.address) details.push(`<i class="fas fa-map-marker-alt mr-1"></i> ${contact.address}`);
        contactDetailsEl.innerHTML = details.join(' &nbsp;|&nbsp; ');

        // Update add buttons based on type
        if (contact.type === 'customer') {
            addDebitButton.innerHTML = `<i class="fas fa-minus-circle"></i> Tambah Piutang (Bon)`;
        } else {
            addDebitButton.innerHTML = `<i class="fas fa-minus-circle"></i> Tambah Hutang`;
        }

        const ledgers = await getAllFromDB('ledgers', 'contactId', contactId);
        
        // Calculate balance
        let balance = 0;
        ledgers.sort((a, b) => new Date(b.date) - new Date(a.date)); // Newest first

        ledgers.forEach(l => {
            if (l.type === 'debit') balance += l.amount;
            else balance -= l.amount;
        });

        // Add summary header inside history
        let html = `
            <div class="bg-blue-50 p-3 rounded-lg mb-3 flex justify-between items-center">
                <span class="text-sm font-semibold text-gray-700">Sisa ${contact.type === 'customer' ? 'Piutang' : 'Hutang'}:</span>
                <span class="text-xl font-bold ${balance > 0 ? 'text-red-600' : 'text-green-600'}">Rp ${window.formatCurrency(balance)}</span>
            </div>
        `;

        if (ledgers.length === 0) {
            html += `<p class="text-gray-500 text-center py-4">Belum ada riwayat transaksi.</p>`;
        } else {
            html += ledgers.map(l => {
                const isDebit = l.type === 'debit';
                const color = isDebit ? 'text-red-600' : 'text-green-600';
                const sign = isDebit ? '+' : '-';
                
                // Show due date if exists and is debit
                let dueDateHtml = '';
                if (isDebit && l.dueDate) {
                    const isOverdue = new Date(l.dueDate) < new Date() && balance > 0;
                    const dueClass = isOverdue ? 'text-red-500 font-bold' : 'text-gray-500';
                    dueDateHtml = `<br><small class="${dueClass}"><i class="far fa-clock"></i> JT: ${new Date(l.dueDate).toLocaleDateString('id-ID')}</small>`;
                }

                return `
                    <div class="flex justify-between items-center border-b py-2 last:border-0 relative group">
                        <div>
                            <p class="font-semibold text-gray-800">${l.description || '-'}</p>
                            <p class="text-xs text-gray-500">
                                ${new Date(l.date).toLocaleString('id-ID')}
                                ${dueDateHtml}
                            </p>
                        </div>
                        <div class="text-right">
                            <span class="font-bold ${color}">${sign} Rp ${window.formatCurrency(l.amount)}</span>
                            <button onclick="event.stopPropagation(); showLedgerActions(event, ${l.id}, '${l.description || ''}', ${l.amount}, '${l.dueDate || ''}')" class="ml-2 text-gray-400 hover:text-gray-600 p-1">
                                <i class="fas fa-ellipsis-v"></i>
                            </button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        historyList.innerHTML = html;
        modal.classList.remove('hidden');

    } catch (e) {
        console.error("Show ledger modal error", e);
        window.showToast('Gagal memuat data buku besar.');
    }
}

export function closeLedgerModal() {
    document.getElementById('ledgerModal').classList.add('hidden');
    currentLedgerContactId = null;
    // Refresh main list to update balance
    fetchAndRenderContacts();
    window.updateDashboardSummaries();
}

export function showAddLedgerEntryModal(entryId = null, type = 'debit') {
    currentLedgerType = type;
    editingLedgerEntryId = entryId;
    
    const title = document.getElementById('addLedgerEntryTitle');
    const amountInput = document.getElementById('ledgerAmount');
    const descInput = document.getElementById('ledgerDescription');
    const dueDateInput = document.getElementById('ledgerDueDate');
    const dueDateContainer = document.getElementById('ledgerDueDateContainer');

    amountInput.value = '';
    descInput.value = '';
    dueDateInput.value = '';

    // If type is credit (Payment), hide due date
    if (type === 'credit') {
        dueDateContainer.classList.add('hidden');
        title.textContent = 'Catat Pembayaran';
    } else {
        dueDateContainer.classList.remove('hidden');
        title.textContent = 'Tambah Catatan (Hutang/Piutang)';
    }

    document.getElementById('addLedgerEntryModal').classList.remove('hidden');
}

export function closeAddLedgerEntryModal() {
    document.getElementById('addLedgerEntryModal').classList.add('hidden');
}

export async function saveLedgerEntry() {
    const amount = parseFloat(document.getElementById('ledgerAmount').value);
    const description = document.getElementById('ledgerDescription').value.trim();
    const dueDate = document.getElementById('ledgerDueDate').value;

    if (isNaN(amount) || amount <= 0) {
        window.showToast('Jumlah harus lebih dari 0.');
        return;
    }
    if (!description) {
        window.showToast('Keterangan wajib diisi.');
        return;
    }

    try {
        const entry = {
            contactId: currentLedgerContactId,
            amount,
            description,
            type: currentLedgerType,
            date: new Date().toISOString(),
            userId: window.app.currentUser ? window.app.currentUser.id : null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        if (currentLedgerType === 'debit' && dueDate) {
            entry.dueDate = new Date(dueDate).toISOString();
        }

        const id = await putToDB('ledgers', entry);
        await queueSyncAction('CREATE_LEDGER', { ...entry, id });
        
        window.showToast('Transaksi berhasil dicatat.');
        closeAddLedgerEntryModal();
        showLedgerModal(currentLedgerContactId); // Refresh history

    } catch (e) {
        console.error("Save ledger error", e);
        window.showToast('Gagal menyimpan transaksi.');
    }
}

// Popover Actions for Ledger Item
export function showLedgerActions(event, id, description, amount, currentDueDate) {
    const popover = document.getElementById('ledgerActionsPopover');
    if (!popover) return;

    window.app.activePopover = popover;

    // Position
    const rect = event.target.getBoundingClientRect();
    popover.style.top = `${rect.bottom + window.scrollY}px`;
    popover.style.left = `${rect.left - 100}px`; // Shift left to keep on screen

    let actionsHtml = ``;
    actionsHtml += `<a onclick="showEditDueDateModal(${id}, '${currentDueDate}')" class="text-gray-700"><i class="far fa-calendar-alt mr-2"></i>Atur Jatuh Tempo</a>`;
    actionsHtml += `<a onclick="deleteLedgerEntry(${id})" class="text-red-600"><i class="fas fa-trash mr-2"></i>Hapus</a>`;

    popover.innerHTML = actionsHtml;
    popover.classList.remove('hidden');
}

export function closeLedgerActions() {
    const popover = document.getElementById('ledgerActionsPopover');
    if (popover) popover.classList.add('hidden');
    window.app.activePopover = null;
}

export function showEditDueDateModal(id, currentDueDateStr) {
    closeLedgerActions();
    document.getElementById('editDueDateEntryId').value = id;
    const dateInput = document.getElementById('newDueDate');
    
    if (currentDueDateStr && currentDueDateStr !== 'undefined') {
        const date = new Date(currentDueDateStr);
        // Format to YYYY-MM-DD
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        dateInput.value = `${year}-${month}-${day}`;
    } else {
        dateInput.value = '';
    }
    
    document.getElementById('editDueDateModal').classList.remove('hidden');
}

export function closeEditDueDateModal() {
    document.getElementById('editDueDateModal').classList.add('hidden');
}

export async function saveDueDate() {
    const id = parseInt(document.getElementById('editDueDateEntryId').value);
    const dateVal = document.getElementById('newDueDate').value;
    
    try {
        const entry = await getFromDB('ledgers', id);
        if (entry) {
            entry.dueDate = dateVal ? new Date(dateVal).toISOString() : null;
            entry.updatedAt = new Date().toISOString();
            await putToDB('ledgers', entry);
            await queueSyncAction('UPDATE_LEDGER', entry);
            
            window.showToast('Jatuh tempo diperbarui.');
            closeEditDueDateModal();
            showLedgerModal(currentLedgerContactId);
        }
    } catch (e) {
        console.error("Save due date error", e);
        window.showToast('Gagal update jatuh tempo');
    }
}

export function deleteLedgerEntry(id) {
    closeLedgerActions();
    window.showConfirmationModal('Hapus Transaksi', 'Hapus catatan ini? Saldo akan disesuaikan.', async () => {
        try {
            const entry = await getFromDB('ledgers', id);
            const tx = window.app.db.transaction('ledgers', 'readwrite');
            tx.objectStore('ledgers').delete(id);
            tx.oncomplete = async () => {
                await queueSyncAction('DELETE_LEDGER', entry);
                window.showToast('Catatan dihapus.');
                showLedgerModal(currentLedgerContactId);
            };
        } catch (e) {
            console.error("Delete ledger error", e);
        }
    }, 'Ya, Hapus', 'bg-red-500');
}

// --- DUE DATE NOTIFICATIONS ---

export async function checkDueDateNotifications() {
    const notifCard = document.getElementById('dueDateNotificationCard');
    const countEl = document.getElementById('dueDateCount');
    if (!notifCard || !countEl) return;

    try {
        const ledgers = await getAllFromDB('ledgers');
        const contacts = await getAllFromDB('contacts');
        const contactMap = new Map(contacts.map(c => [c.id, c]));

        const now = new Date();
        const threeDaysFromNow = new Date();
        threeDaysFromNow.setDate(now.getDate() + 3);

        const dueItems = ledgers.filter(l => {
            if (l.type !== 'debit' || !l.dueDate) return false;
            
            const contact = contactMap.get(l.contactId);
            if (!contact) return false;
            
            const dueDate = new Date(l.dueDate);
            return dueDate <= threeDaysFromNow;
        }).map(l => ({
            ...l,
            contactName: contactMap.get(l.contactId)?.name || 'Unknown'
        }));

        if (dueItems.length > 0) {
            countEl.textContent = dueItems.length;
            notifCard.classList.remove('hidden');
            notifCard.onclick = () => showDueDateModal(dueItems);
            window.app.dueItemsList = dueItems;
        } else {
            notifCard.classList.add('hidden');
        }

    } catch (e) {
        console.error("Check due date error", e);
    }
}

export function showDueDateModal(items = []) {
    const listItems = items.length > 0 ? items : window.app.dueItemsList;
    const listEl = document.getElementById('dueDateList');
    
    if (listItems.length === 0) {
        listEl.innerHTML = '<p class="text-center text-gray-500">Tidak ada tagihan jatuh tempo.</p>';
    } else {
        listItems.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
        
        listEl.innerHTML = listItems.map(item => {
            const dueDate = new Date(item.dueDate);
            const isOverdue = dueDate < new Date();
            const statusClass = isOverdue ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800';
            const statusText = isOverdue ? 'Terlambat' : 'Segera';

            return `
                <div class="card p-3 border-l-4 ${isOverdue ? 'border-red-500' : 'border-yellow-500'} clickable" onclick="viewLedgerFromDueDateModal(${item.contactId})">
                    <div class="flex justify-between items-start">
                        <div>
                            <p class="font-bold text-gray-800">${item.contactName}</p>
                            <p class="text-sm text-gray-600">${item.description}</p>
                            <p class="text-xs text-gray-500 mt-1"><i class="far fa-clock"></i> ${dueDate.toLocaleDateString('id-ID')}</p>
                        </div>
                        <div class="text-right">
                            <span class="text-xs font-bold px-2 py-1 rounded-full ${statusClass}">${statusText}</span>
                            <p class="font-bold text-red-600 mt-2">Rp ${window.formatCurrency(item.amount)}</p>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }
    
    document.getElementById('dueDateModal').classList.remove('hidden');
}

export function closeDueDateModal() {
    document.getElementById('dueDateModal').classList.add('hidden');
}

export function viewLedgerFromDueDateModal(contactId) {
    closeDueDateModal();
    showLedgerModal(contactId);
}
