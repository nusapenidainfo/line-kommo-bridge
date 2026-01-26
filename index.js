const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Чтобы принимать JSON из LINE и Kommo
app.use(express.json());

// Простой health-check, чтобы проверять, жив ли сервер
app.get('/', (req, res) => {
  res.send('LINE–Kommo bridge is running');
});

// Вебхук для LINE
app.post('/line/webhook', (req, res) => {
  console.log('Incoming LINE webhook body:', JSON.stringify(req.body, null, 2));

  // TODO: здесь позже добавим отправку данных в Kommo
  res.status(200).send('OK');
});

// Заглушка для вебхука от Kommo (на будущее)
app.post('/kommo/incoming', (req, res) => {
  console.log('Incoming Kommo webhook body:', JSON.stringify(req.body, null, 2));
  res.status(200).send('OK');
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
