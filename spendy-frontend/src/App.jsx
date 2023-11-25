import { BrowserRouter as Router, Route, Routes } from "react-router-dom";
import TransactionsPage from "./pages/TransactionsPage";
import "./App.css";

function App() {
  return (
    <Router>
      <Routes>
        <Route exact path="/" element={<TransactionsPage />} />
      </Routes>
    </Router>
  );
}
export default App;
