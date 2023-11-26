import Logo from "./Logo";
import styles from "../css/Navbar.module.css";

function Navbar() {
  return (
    <nav className={styles.nav}>
      <Logo />
    </nav>
  );
}

export default Navbar;
