## ¿Qué es Web3 IM?

Un mensajero donde los mensajes viajan por una red entre pares en lugar del servidor de una empresa: nadie guarda todo el historial y nadie puede leerlo o borrarlo en el camino.

La cartera vive en la misma aplicación, porque la identidad detrás de los mensajes es la misma clave que guarda los fondos. No hay cuenta en un servidor: el par de claves es la cuenta.

[Documento completo](en/web3im.md)
[Status](https://status.im)

## ¿Qué es la red Status?

Status es un conjunto de programas de código abierto — la aplicación Status, el motor `status-go` y el transporte Waku — que juntos forman una sola red. Los nodos se encuentran entre sí mediante una lista de arranque e intercambian mensajes sellados; el mensajero y la cartera viajan por la misma red.

Stauri se conecta a la misma red que Status Desktop. Por eso los usuarios de Stauri y los de Status pueden escribirse entre sí: es una red, no un puente entre dos.

[Arquitectura](en/architecture.md)
[Waku](https://waku.org)

## Contraseña y frase semilla

Son dos secretos distintos, y confundirlos es la forma más común de perder el acceso.

La **contraseña** cifra el perfil en este dispositivo. Nunca sale del teléfono o del ordenador, y nadie —ni en Status ni en Stauri— puede leerla.

La **frase semilla** — doce palabras — es la clave maestra del perfil y de los fondos: restaura todo en cualquier dispositivo. Perder la contraseña a menudo se puede sobrevivir: un PIN corto la descifra y la frase semilla restaura el perfil. Perder la frase semilla no: no hay soporte, no hay restablecimiento, no hay excepciones.

[Autenticación y sincronización](en/auth_and_sync.md)

## Stauri frente a Status

Stauri usa el mismo motor y la misma red que Status. Las diferencias son dos: la tecnología y el vocabulario, más un pequeño parche al motor, descrito abajo.

**La tecnología.** Tauri + Svelte + Tailwind en lugar de Nix + Nim/QML. Los módulos de Status son monolitos construidos con Nix. Stauri tiene un ciclo de edición corto y un solo código Rust en escritorio y Android. Rust es obligatorio solo para los módulos core que hablan con Tauri y para la criptografía; el resto puede escribirse en Go, Nim, Python o lo que sea.

**El vocabulario.** En la interfaz de Stauri no hay «Comunidad»: los canales son ACC — Autor, Canal, Comentario. Una comunidad de Status se convierte en un contenedor técnico con un canal; Stauri oculta el contenedor y muestra los canales directamente.

Dos diferencias más: en la sección dApps pueden conectarse no solo canales de Status, sino también fuentes RSS de otros orígenes, por ejemplo Telegram; y un binario más pequeño gasta menos batería.

[Comparación](en/comparison.md)
[Status](https://status.im)
[Logos](https://logos.co)

## El parche a status-go

Stauri construye el mismo motor que Status — el `status-go` oficial — con una pequeña adición. El motor lee la lista de perfiles una vez al empezar y la guarda en memoria; hacía falta poder leer la lista de otra red sin reiniciar la aplicación. El parche añade una función que cierra esa lista para que pueda volver a abrirse por la red elegida.

Son dos archivos y unas cuarenta líneas. No toca la criptografía ni las claves: la lista que cierra guarda nombres de perfiles y ajustes, no secretos. El parche y el diff completo están publicados: cualquiera puede leerlos, y la razón está escrita al lado.

Sin el parche Stauri funciona igualmente; solo al cambiar de red pide reiniciar la aplicación.

[El parche, explicado](https://github.com/magnus-redkin/stauri-app/blob/main/src-tauri/status-go/README.md)
[El diff completo](https://github.com/status-im/status-go/compare/766535cf336416a11a92f46faf4df5ac6af4a0b8...magnus-redkin:status-go:stauri/close-accounts)

## ¿Cómo obtengo un nombre ENS?

ENS es un nombre legible para una dirección: en lugar de una larga cadena de caracteres, la gente ve `yourname.eth` y puede pagarle.

En Stauri: abrir Perfil, elegir el nombre ENS, comprobar si está libre, mirar el precio y confirmar. El nombre se registra en el subdominio de Status (`yourname.stateofus.eth`) y pertenece a su dirección. Cuesta una tasa anual en ETH más la comisión de la red.

Un nombre no es un nombre de usuario: no ayuda a que nadie le encuentre en el mensajero, facilita que le paguen.

[ENS](https://ens.domains)

## ¿Cómo sincronizo dispositivos?

Sincronizar mueve un perfil — con sus claves e historial — de un dispositivo a otro. Ambos deben estar en la misma red local, por ejemplo el mismo Wi-Fi.

En el dispositivo que ya tiene el perfil, abra Perfil y tome el **Código de sincronización**. En el dispositivo vacío, elija «Restaurar o sincronizar» y escriba el código: el perfil llega. El código dura unos minutos y no puede reutilizarse.

[Autenticación y sincronización](en/auth_and_sync.md)

## Hecho y pendiente

Lo que funciona hoy y lo que viene. La lista es corta a propósito: solo lo que define el producto.

**HECHO**

- Perfil: crear, PIN, iniciar sesión, frase semilla, nombre para mostrar.
- Chats, canales, contactos, comentarios.
- Cartera: activos, enviar, recibir, intercambiar; nombre ENS.
- Market, fuentes externas, dApps en ventanas separadas.
- Cuatro temas, cuatro idiomas.
- Compilación para Android; cambio de red sin reiniciar.

**PENDIENTE**

- Compilación para Windows.
- Comprar cripto con dinero fiat (por ahora, marcador).
- `window.ethereum` en las ventanas de dApp.
- Historial de transacciones, NFT, puente.
- Keycard, notificaciones push.

[Planes y arquitectura](en/architecture.md)
