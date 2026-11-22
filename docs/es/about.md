## ¿Qué es Web3 IM?

Un mensajero donde los mensajes viajan por una red entre pares en lugar de un servidor de empresa: nadie guarda todo el historial y nadie puede borrarlo ni leerlo. La cartera vive en la misma aplicación, porque la identidad detrás de los mensajes es la misma clave que guarda los fondos.

- No hay cuenta en un servidor: el par de claves es la cuenta.
- La frase semilla de 12 palabras es la clave maestra del perfil y de los fondos.
- Los mensajes van cifrados de extremo a extremo; los nodos los retransmiten sin leerlos.

[Documento completo](ru/web3im.md)

## ¿Qué es la red Status?

Status es un conjunto de programas de código abierto (la aplicación Status, el motor status-go y el transporte Waku) que forman una sola red. Los nodos se encuentran mediante una lista de arranque (un «fleet») e intercambian mensajes sellados; la misma red lleva el mensajero y el tráfico de la cartera.

- Waku es el transporte: almacena y reenvía sobres sellados.
- Un fleet es la lista de nodos de arranque; Status mantiene uno público.
- status-go es el motor; Stauri lo carga como biblioteca y dibuja su propia interfaz.

[Documento completo](en/architecture.md)

## Stauri frente a Status.im

Stauri usa el mismo motor y la misma red que Status Desktop. Las diferencias son dos: la tecnología y el vocabulario.

1. **Tauri + Svelte en lugar de Nix + Nim/QML.** La interfaz es un front end web en Svelte: ciclo de edición corto, un solo código Rust en escritorio y Android y ventanas aisladas para dApps externas. Status Desktop es un monolito construido con Nix en Nim y QML.
2. **No hay «Comunidad» en la interfaz; los canales son ACC.** Una comunidad de Status es un contenedor técnico con un solo canal. Stauri oculta el contenedor y muestra los canales (ACC) directamente, como la entidad que el usuario reconoce.

[Documento completo](ru/comparison.md)

## Hecho y pendiente

Lo que ya funciona y lo que viene. La lista es corta a propósito: solo lo que define el producto.

**HECHO**

- Perfil: crear, iniciar sesión, frase semilla.
- Chats, canales, contactos, comentarios.
- Cartera: activos, enviar, recibir, intercambiar.
- Nombre ENS en el perfil.
- Market, fuentes externas, dApps en ventanas separadas.
- Cuatro temas; cuatro idiomas.

**PENDIENTE**

- Compilación para Android; para Windows.
- Comprar cripto con dinero fiat (por ahora, marcador).
- window.ethereum en las ventanas de dApp.
- Historial de transacciones, NFT, puente.
- Keycard, notificaciones push.
