self.addEventListener("push", (event) => {
  if (!event.data) return;
  const notification = event.data.json();
  event.waitUntil(
    self.registration.showNotification(notification.title, {
      body: notification.body,
      data: { url: notification.url },
      tag: "chatpack-thread-reply",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  if (typeof url === "string") event.waitUntil(clients.openWindow(url));
});
