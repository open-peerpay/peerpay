import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./styles.css";
import { AdminApp, PaymentPageApp } from "./App";

const App = window.location.pathname.startsWith("/pay/") ? PaymentPageApp : AdminApp;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
