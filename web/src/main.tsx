import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import App from "./App";
import { system } from "./ui/system";
import { ThemeProvider } from "./ui/theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChakraProvider value={system}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ChakraProvider>
  </StrictMode>,
);
