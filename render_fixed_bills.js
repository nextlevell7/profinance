window.renderFixedBillsGrid = function() {
    const grid = document.getElementById('fixed-bills-grid');
    const badge = document.getElementById('fb-summary-badge');
    if (!grid) return;
    
    let fixedBills = [];
    if (typeof getUniqueFixedBills === 'function') {
        fixedBills = getUniqueFixedBills();
    } else {
        if (typeof transactions !== 'undefined') {
            const allFixed = transactions.filter(t => (t.profile || 'personal') === (typeof currentProfile !== 'undefined' ? currentProfile : 'personal') && t.type === 'expense' && t.isRecurring === true);
            const seen = new Set();
            allFixed.forEach(t => {
                if(!t.date) return;
                const key = (t.desc || t.category) + '_' + t.amount + '_' + t.date.split('-')[2];
                if(!seen.has(key)) { seen.add(key); fixedBills.push(t); }
            });
        }
    }
    
    if (badge) {
        badge.innerText = fixedBills.length + ' ' + (fixedBills.length === 1 ? 'conta cadastrada' : 'contas cadastradas');
    }
    
    grid.innerHTML = '';
    
    if (fixedBills.length === 0) {
        grid.innerHTML = '<div style="color:var(--text-secondary); grid-column: 1/-1; text-align:center; padding: 25px; background: rgba(30,41,59,0.2); border-radius: 12px; border: 1px dashed rgba(255,255,255,0.08);">Nenhuma conta fixa cadastrada. Clique no botão acima para adicionar!</div>';
        return;
    }
    
    fixedBills.forEach(b => {
        const parts = b.date.split('-');
        const day = parts[2];
        let initial = '📄';
        if(b.category) {
            const emojis = b.category.match(/[\p{Emoji}\u200d]+/gu);
            if(emojis && emojis.length > 0) initial = emojis[0];
            else initial = b.category.charAt(0).toUpperCase();
        }
        const name = b.desc || b.category.replace(/[\p{Emoji}\u200d]+/gu, '').trim() || 'Conta Fixa';
        const formattedVal = typeof formatCurrency === 'function' ? formatCurrency(b.amount) : 'R$ ' + Number(b.amount).toFixed(2).replace('.', ',');
        
        const card = document.createElement('div');
        card.style.cssText = 'padding: 1.25rem; display: flex; flex-direction: column; gap: 0.6rem; justify-content: space-between; border-radius: 14px; background: linear-gradient(145deg, rgba(30, 41, 59, 0.6) 0%, rgba(15, 23, 42, 0.7) 100%); border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 4px 15px rgba(0,0,0,0.2); transition: transform 0.2s, box-shadow 0.2s; position: relative;';
        
        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem;">
                <div style="display: flex; align-items: center; gap: 0.75rem; min-width: 0;">
                    <div style="background: rgba(0, 163, 255, 0.12); color: #00A3FF; width: 40px; height: 40px; min-width: 40px; border-radius: 12px; display: flex; justify-content: center; align-items: center; font-size: 1.3rem; border: 1px solid rgba(0, 163, 255, 0.25);">
                        ${initial}
                    </div>
                    <div style="min-width: 0;">
                        <div style="font-weight: 700; color: var(--text-main); font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${typeof escapeHtml === 'function' ? escapeHtml(name) : name}">${typeof escapeHtml === 'function' ? escapeHtml(name) : name}</div>
                        <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">Vence todo dia <strong style="color: #60A5FA; font-weight: 700;">${day}</strong></div>
                    </div>
                </div>
                <button type="button" class="btn-delete-fixed-bill" title="Excluir esta Conta Fixa" style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); color: #EF4444; width: 32px; height: 32px; min-width: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: 0.2s; font-size: 0.9rem;">
                    🗑️
                </button>
            </div>
            <div style="margin-top: 0.75rem; display: flex; justify-content: space-between; align-items: flex-end;">
                <div style="font-size: 1.25rem; font-weight: 800; color: #F87171; letter-spacing: -0.3px;">${formattedVal}</div>
                <span style="font-size: 0.7rem; font-weight: 600; color: #94A3B8; background: rgba(255,255,255,0.06); padding: 3px 8px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.5px;">Recorrente</span>
            </div>
        `;
        
        const btnDel = card.querySelector('.btn-delete-fixed-bill');
        if (btnDel) {
            btnDel.addEventListener('click', function(e) {
                e.stopPropagation();
                if (typeof window.deleteFixedBill === 'function') {
                    window.deleteFixedBill(name, b.amount, day);
                }
            });
        }
        
        grid.appendChild(card);
    });
};
