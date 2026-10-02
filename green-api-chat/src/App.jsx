import { useEffect, useRef, useState } from 'react';
import './App.css';

const GREEN_API_URL = 'https://api.green-api.com';

// `waInstance` is GREEN-API's shared route name, including for Telegram instances.
const getTelegramApiUrl = (idInstance, apiTokenInstance, method) =>
  `${GREEN_API_URL}/waInstance${idInstance.trim()}/${method}/${apiTokenInstance.trim()}`;

const formatTime = (timestamp = Date.now()) =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const getErrorMessage = async (response, fallback) => {
  try {
    const data = await response.json();
    return data.message || data.error || fallback;
  } catch {
    return fallback;
  }
};

const getTextFromNotification = (messageData) => {
  if (messageData?.typeMessage === 'textMessage') {
    return messageData.textMessageData?.textMessage;
  }
  if (messageData?.typeMessage === 'quotedMessage') {
    return messageData.extendedTextMessageData?.text;
  }
  return null;
};

export default function App() {
  const [idInstance, setIdInstance] = useState('');
  const [apiTokenInstance, setApiTokenInstance] = useState('');
  const [isAuth, setIsAuth] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authError, setAuthError] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [activeChat, setActiveChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [chatError, setChatError] = useState('');
  const [pollingError, setPollingError] = useState('');
  const activeChatRef = useRef(null);
  const messagesEndRef = useRef(null);
  const activeChatId = activeChat?.chatId;

  useEffect(() => {
    activeChatRef.current = activeChat;
  }, [activeChat]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleLogin = async (event) => {
    event.preventDefault();
    setAuthError('');
    setIsLoggingIn(true);
    try {
      const response = await fetch(
        getTelegramApiUrl(idInstance, apiTokenInstance, 'getStateInstance'),
      );
      if (!response.ok) {
        throw new Error(await getErrorMessage(response, 'Не удалось проверить данные GREEN-API.'));
      }
      const { stateInstance } = await response.json();
      if (stateInstance !== 'authorized') {
        throw new Error(
          `Инстанс не готов к работе: ${stateInstance || 'неизвестный статус'}. Авторизуйте его в личном кабинете GREEN-API.`,
        );
      }

      const settingsResponse = await fetch(
        getTelegramApiUrl(idInstance, apiTokenInstance, 'getSettings'),
      );
      if (!settingsResponse.ok) {
        throw new Error(
          await getErrorMessage(settingsResponse, 'Не удалось проверить настройки инстанса.'),
        );
      }
      const settings = await settingsResponse.json();
      if (settings.incomingWebhook !== 'yes' || settings.webhookUrl) {
        throw new Error(
          'Для получения ответов включите incomingWebhook и оставьте webhookUrl пустым в настройках инстанса GREEN-API.',
        );
      }
      if (settings.typeInstance !== 'telegram') {
        throw new Error('Этот интерфейс работает только с Telegram-инстансом GREEN-API.');
      }

      setIsAuth(true);
    } catch (error) {
      setAuthError(error.message || 'Не удалось подключиться к GREEN-API.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleCreateChat = async (event) => {
    event.preventDefault();
    const formattedPhone = phoneNumber.replace(/\D/g, '');
    if (formattedPhone.length < 11 || formattedPhone.length > 16) {
      setChatError('Введите номер в международном формате: от 11 до 16 цифр.');
      return;
    }
    setChatError('');
    setIsCreatingChat(true);
    try {
      const response = await fetch(getTelegramApiUrl(idInstance, apiTokenInstance, 'checkAccount'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: Number(formattedPhone) }),
      });
      if (!response.ok) {
        throw new Error(await getErrorMessage(response, 'Не удалось проверить номер.'));
      }
      const contact = await response.json();
      if (!contact.exist) {
        throw new Error('На этом номере не найден аккаунт Telegram.');
      }
      setActiveChat({
        phone: formattedPhone,
        chatId: contact.chatId,
      });
      setMessages([]);
      setNewMessage('');
    } catch (error) {
      setChatError(error.message || 'Не удалось создать чат.');
    } finally {
      setIsCreatingChat(false);
    }
  };

  const handleSendMessage = async (event) => {
    event.preventDefault();
    const messageText = newMessage.trim();
    if (!messageText || !activeChat || isSending) return;
    setChatError('');
    setIsSending(true);
    try {
      const response = await fetch(getTelegramApiUrl(idInstance, apiTokenInstance, 'sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: activeChat.chatId, message: messageText }),
      });
      if (!response.ok) {
        throw new Error(await getErrorMessage(response, 'Не удалось отправить сообщение.'));
      }
      const data = await response.json();
      setMessages((current) => [
        ...current,
        {
          id: data.idMessage || `outgoing-${Date.now()}`,
          text: messageText,
          type: 'outgoing',
          time: formatTime(),
        },
      ]);
      setNewMessage('');
    } catch (error) {
      setChatError(error.message || 'Не удалось отправить сообщение.');
    } finally {
      setIsSending(false);
    }
  };

  useEffect(() => {
    if (!isAuth || !activeChatId) return undefined;
    const controller = new AbortController();

    const deleteNotification = async (receiptId) => {
      const response = await fetch(
        `${getTelegramApiUrl(idInstance, apiTokenInstance, 'deleteNotification')}/${receiptId}`,
        {
        method: 'DELETE',
        signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error('Не удалось удалить обработанное уведомление.');
    };

    const processNotification = (body) => {
      if (body?.typeWebhook !== 'incomingMessageReceived') return;
      const text = getTextFromNotification(body.messageData);
      const senderId = body.senderData?.chatId;
      const currentChat = activeChatRef.current;
      if (!text || !senderId || !currentChat) return;

      const belongsToCurrentChat =
        senderId === currentChat.chatId ||
        String(body.senderData?.senderPhoneNumber || '') === currentChat.phone;
      if (!belongsToCurrentChat) return;

      setMessages((current) => {
        const id = body.idMessage || `incoming-${body.timestamp}-${senderId}`;
        if (current.some((message) => message.id === id)) return current;
        return [
          ...current,
          {
            id,
            text,
            type: 'incoming',
            time: formatTime(body.timestamp ? body.timestamp * 1000 : Date.now()),
          },
        ];
      });
    };

    const poll = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(
            `${getTelegramApiUrl(idInstance, apiTokenInstance, 'receiveNotification')}?receiveTimeout=5`,
            { signal: controller.signal },
          );
          if (!response.ok) {
            throw new Error(
              await getErrorMessage(response, 'Ошибка получения уведомлений GREEN-API.'),
            );
          }
          const notification = await response.json();
          setPollingError('');
          if (notification?.receiptId) {
            processNotification(notification.body);
            await deleteNotification(notification.receiptId);
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          setPollingError(
            `${error.message || 'Не удалось получить сообщения.'} Проверьте, что incomingWebhook включён, а webhookUrl пуст. Повтор через 3 секунды.`,
          );
          await new Promise((resolve) => window.setTimeout(resolve, 3000));
        }
      }
    };

    poll();
    return () => controller.abort();
  }, [isAuth, activeChatId, idInstance, apiTokenInstance]);

  if (!isAuth) {
    return (
      <main className="auth-container">
        <form onSubmit={handleLogin} className="auth-form">
          <h1>Вход в Telegram через GREEN-API</h1>
          <label>
            idInstance
            <input type="text" inputMode="numeric" placeholder="Введите idInstance" value={idInstance}
              onChange={(event) => setIdInstance(event.target.value)} autoComplete="username" required />
          </label>
          <label>
            apiTokenInstance
            <input type="password" placeholder="Введите токен" value={apiTokenInstance}
              onChange={(event) => setApiTokenInstance(event.target.value)} autoComplete="current-password" required />
          </label>
          {authError && <p className="error-message" role="alert">{authError}</p>}
          <button type="submit" disabled={isLoggingIn}>
            {isLoggingIn ? 'Проверяем…' : 'Войти'}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="chat-app">
      <aside className="sidebar">
        <h2>Создать чат</h2>
        <form onSubmit={handleCreateChat}>
          <label htmlFor="phone">Номер получателя</label>
          <input id="phone" type="tel" inputMode="tel" placeholder="77123456789"
            value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} required />
          <button type="submit" disabled={isCreatingChat}>
            {isCreatingChat ? 'Проверяем…' : 'Открыть чат'}
          </button>
        </form>
        {activeChat && <div className="active-chat-info">Чат с <strong>+{activeChat.phone}</strong></div>}
        {chatError && <p className="error-message" role="alert">{chatError}</p>}
      </aside>

      <section className="main-chat" aria-label="Чат">
        {activeChat ? (
          <>
            <header className="chat-header">
              <span>+{activeChat.phone}</span>
              <small>{pollingError ? 'Проблема с подключением' : 'Ожидаем сообщения'}</small>
            </header>
            {pollingError && <p className="polling-error" role="status">{pollingError}</p>}
            <div className="messages-list" aria-live="polite">
              {messages.length === 0 && <p className="empty-messages">Напишите первое сообщение</p>}
              {messages.map((message) => (
                <article key={message.id} className={`message ${message.type}`}>
                  <p className="message-text">{message.text}</p>
                  <time className="message-time">{message.time}</time>
                </article>
              ))}
              <div ref={messagesEndRef} />
            </div>
            <form onSubmit={handleSendMessage} className="send-message-form">
              <label className="sr-only" htmlFor="message">Сообщение</label>
              <input id="message" type="text" placeholder="Введите сообщение…" value={newMessage}
                onChange={(event) => setNewMessage(event.target.value)} autoComplete="off" />
              <button type="submit" disabled={!newMessage.trim() || isSending}>
                {isSending ? 'Отправка…' : 'Отправить'}
              </button>
            </form>
          </>
        ) : (
          <div className="no-chat">Введите номер и откройте чат</div>
        )}
      </section>
    </main>
  );
}
