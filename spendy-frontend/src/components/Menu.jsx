import { useEffect, useRef } from "react";
import { menu, row } from "../css/Menu.module.css";
import { FaPencilAlt, FaEyeSlash, FaTrash, FaEye } from "react-icons/fa";

import { motion } from "framer-motion";
const Menu = ({ triggerHide, hidden }) => {
  const menuElem = useRef(null);
  useEffect(() => {
    const handler = (event) => {
      if (!event.composedPath().includes(menuElem.current)) triggerHide();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: -15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 15 }}
      className={menu}
    >
      <div className={row} data-action="edit">
        <FaPencilAlt />
        Edit
      </div>
      <div className={row} data-action="toggleVisibility">
        {hidden ? (
          <>
            <FaEye />
            Show
          </>
        ) : (
          <>
            <FaEyeSlash />
            Hide
          </>
        )}
      </div>
      <div className={row} data-action="delete">
        <FaTrash />
        Delete
      </div>
    </motion.div>
  );
};

export default Menu;
