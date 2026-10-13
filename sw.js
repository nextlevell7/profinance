self.addEventListener('push', function(event) {
    const data = event.data ? event.data.json() : { title: 'Lembrete ProFinance', body: 'Você tem contas a vencer!' };
    
    const options = {
        body: data.body,
        icon: 'https://profinance-ten.vercel.app/favicon.ico',
        badge: 'https://profinance-ten.vercel.app/favicon.ico',
        vibrate: [200, 100, 200],
        data: { url: data.url || '/' }
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data.url)
    );
});
