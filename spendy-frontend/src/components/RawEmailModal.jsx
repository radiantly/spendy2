import {
  overlay,
  topRow,
  moreInfo,
  subject,
} from "../css/RawEmailModal.module.css";
import { container } from "../css/Dash.module.css";
import { FaTimes } from "react-icons/fa";
import { useEffect, useRef } from "react";
import { motion } from "framer-motion";

const RawEmailModal = ({ mail, onClose }) => {
  const overlayRef = useRef();
  const containerRef = useRef();

  // We need a useEffect here because react events don't seem to have composedPath
  useEffect(() => {
    const overlayElem = overlayRef.current;

    const handler = (event) =>
      !event.composedPath().includes(containerRef.current) && onClose();

    overlayElem.addEventListener("pointerdown", handler);
    return () => overlayElem.removeEventListener("pointerdown", handler);
  });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className={overlay}
      ref={overlayRef}
    >
      <div className={container} ref={containerRef}>
        <div className={topRow}>
          <details>
            <summary>What is this?</summary>
            <div className={moreInfo}>
              When emails arrive, they are classified as transactional or
              non-transactional. Non-transactional emails such as this one are
              not stored, but simply encrypted and sent to any active sessions
              for either debugging purposes or accepting forwarding
              confirmations. Note that senders are not verified and the below
              email may contain malicious or phishing links.
            </div>
          </details>
          <FaTimes onClick={onClose} />
        </div>
        <div className={subject}>{mail.subject}</div>
        <pre>{mail.body}</pre>
      </div>
    </motion.div>
  );
};
export default RawEmailModal;
