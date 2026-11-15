import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { setRealRecords, type FireRecord } from './data';
import './index.css';

async function bootstrap() {
  try {
    const res = await fetch('/data/pyrosync_records.json');
    if (res.ok) {
      const records = (await res.json()) as FireRecord[];
      setRealRecords(records);
    }
  } catch (err) {
    console.warn('Could not load real PyroSync Gold records:', err);
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

bootstrap();
