import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Distinctive type pairing — pixel blackletter display + warm slab body + pixel mono
import "@fontsource/jacquard-12/400.css";
import "@fontsource/bitter/400.css";
import "@fontsource/bitter/500.css";
import "@fontsource/bitter/600.css";
import "@fontsource/bitter/700.css";
import "@fontsource/vt323/400.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
