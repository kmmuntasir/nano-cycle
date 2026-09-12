import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    mode: "dark",
    primary: { main: "#90caf9" },
    success: { main: "#66bb6a" },
    warning: { main: "#ffa726" },
    error: { main: "#ef5350" },
    background: { default: "#121212", paper: "#1e1e1e" },
  },
  typography: {
    fontFamily: 'Roboto, "Helvetica Neue", sans-serif',
  },
  shape: { borderRadius: 8 },
});
