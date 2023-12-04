import { useEffect, useRef, useState } from "react";
import {
  text,
  modalContainer,
  modal,
  shown,
} from "../css/LastEmail.module.css";
import { Keypair, postJSON } from "../utils";

const LastEmail = () => {
  const [mail, setMail] = useState(null);
  const modalContainerElem = useRef(null);
  const modalElem = useRef(null);
  const [modalVisible, setModalVisible] = useState(false);

  useEffect(() => {
    const handler = (event) =>
      !event.composedPath().includes(modalElem.current) &&
      setModalVisible(false);

    const container = modalContainerElem.current;
    if (!container) return;
    container.addEventListener("pointerdown", handler);
    return () => container.removeEventListener("pointerdown", handler);
  });

  useEffect(() => {
    const userString = localStorage.getItem("user");
    let user;
    try {
      user = JSON.parse(userString);
      if (!user?.username) throw false;
    } catch {
      return;
    }

    let keypair = null;
    Keypair.fromJSON(user.keypair)
      .then((kp) => {
        keypair = kp;
        return postJSON("/api/lastemail", {
          username: user.username,
          public_key: keypair.publicKey,
        });
      })
      .then((response) => response.json())
      .then((response) => keypair.decrypt(response.encrypted))
      .then((mail) => setMail(JSON.parse(mail)));
  }, []);

  if (mail === null) return null;
  return (
    <>
      <div className={text} onClick={() => setModalVisible(true)}>
        Last email sent.
      </div>
      <div
        ref={modalContainerElem}
        className={[modalContainer, modalVisible ? shown : ""].join(" ")}
      >
        <div className={modal} ref={modalElem}>
          {mail?.body}
        </div>
      </div>
    </>
  );
};

export default LastEmail;
