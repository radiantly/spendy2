import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import TransactionsPage from "./pages/TransactionsPage";
import "./App.css";
import LoginRegisterPage from "./pages/LoginRegisterPage";

function App() {
  return (
    <Router>
      <Routes>
        <Route exact path="login" element={<LoginRegisterPage />} />
        <Route exact path="register" element={<LoginRegisterPage />} />
        <Route exact path="/" element={<TransactionsPage />} />
      </Routes>
    </Router>
  );
}
export default App;
