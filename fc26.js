
let xUtSid = "";
let searchUrl = "";
let searchHeaders = {};
let fodderSid = ""

//variabili per sniping
let numeroTentativi;
let start = false;
let carteAcquistate = 0;
let listaFodder= []
let ricercaFodder = false;
let indexFodder = 0;
let idCarteAcquistate= [];

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: "index.html" }); // Apre la GUI in una nuova scheda
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
        if (details.method === "GET" || details.method === "POST") {
          if(start==false){
            chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Filtro di ricerca acquisito'});
          }
          if(details.url.includes("transfermarket?")){
            searchUrl = details.url;
          }   
        }
    } catch (err) {
      console.error('[FC26 listener error]', err);
    }
    },
  { urls: [
    "https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/transfermarket*",
  ] },
  ["requestBody"]
);



chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if(details.url.includes("transfermarket?") && start==false){
        searchHeaders = details.requestHeaders;
        details.requestHeaders.forEach(header => {
            if(header.name.toLowerCase().includes ("x-ut-sid"))
            {
                xUtSid = header.value;
            }
        })
    }
    if(details.url.includes("https://www.futwiz.com/fc26/players") && start==false){
      details.requestHeaders.forEach(header => {
          if(header.name.toLowerCase().includes ("next-action"))
          {
              fodderSid = header.value;
          }
        })
    }
    },
  { urls: ["https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/transfermarket*"] },
  ["requestHeaders"]
);

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.tipo === 'START') {
    start = message.valore;
    
    if(start == true){

      

      // Recupera il numero di tentativi dallo storage
      numeroTentativi = await getNumeroTentativi();
      carteAcquistate = 0;
      
    
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Avvio ricerca'});
      chrome.runtime.sendMessage({ tipo: 'CARTA_ACQUISTATA', valore: ""});

      
      
      
      switch (ricercaFodder) {
        case true:

          
          await sendFodderResearchRequest();

          break;
      
        case false:
          
          let i = 0;
          while(start==true && i < numeroTentativi){
            await sendResearchRequest();

            //aggiorno contatore tentativi rimasti
            chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1)});
            
            let randomValue;
            if((i+1)%5 == 0) randomValue = getRandomInRange(2,5) ; //sleep random tra 1 e 3 secondi ogni 5 tentativi
            else randomValue = Math.random() + 0.5; //sleep random tra 0.5 e 1 secondi
            
            await sleep(randomValue * 1000);
            
            i++;
        }


          break;
      }
      
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Ricerca terminata\n'});
      //ho finito le ricerche, quindi termino ed invio messaggio di stop
      chrome.runtime.sendMessage({ tipo: 'START', valore: false});
      chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: ""});
      start = false;
    }
  }
});


// Define a sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


// Funzione per ottenere numeroTentativi come Promise
const getNumeroTentativi = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['numeroTentativi'], (result) => {
      resolve(result.numeroTentativi || 0); // Default to 0 if undefined
    });
  });
};


function getRandomInRange(min, max) {
  return Math.random() * (max - min + 1) + min;
}


//Funzioni per chiamate HTTP

// Funzione per inviare una richiesta GET (ricerca)
async function sendResearchRequest() {
  try {
    // Controlla che l'URL e l'header siano definiti
    if (!searchUrl || !searchHeaders) {
      console.error("URL o Header non definiti");
      return;
    }

    if(searchUrl.includes('start=0') && !searchUrl.includes('maxb=200')) searchUrl = searchUrl.replace('start=0', 'start=200')
    else if(searchUrl.includes('start=200')) searchUrl = searchUrl.replace('start=200', 'start=0')
        

    const headers = new Headers({
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    "X-UT-SID": xUtSid
    });

    // Invia la richiesta GET
    const response = await fetch(searchUrl, {
      method: "GET",
      headers: headers,
    });
    

    // Controlla la risposta
    if (response.ok) {
      const data = await response.json();
      if(data.auctionInfo && data.auctionInfo.length >0){
        idCarteAcquistate= [];
        
         for (const auction of data.auctionInfo) {
          let tradeId = auction.tradeId;
          let buyNowPrice = auction.buyNowPrice;
          let itemDataId = auction.itemData.id;
          
          await sendBuyNowRequest(tradeId, buyNowPrice,itemDataId, idCarteAcquistate);
          chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Ho trovato ' + data.auctionInfo.length + ' carte'});
          
        };
        
        if(idCarteAcquistate.length > 0) await sendToTransferList();

      } else if(!data.auctionInfo){
        console.error("Errore nella ricerca:", response.status, response.statusText);
      }
    }
  } catch (error) {
    console.error("Errore durante l'invio della richiesta:", error);
  }
}

async function sendBuyNowRequest(tradeId, buyNowPrice, itemId) {
  let buyNowUrl = 'https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/trade/'+ tradeId +'/bid';

  if (!buyNowUrl || !searchHeaders) {
    console.error("URL o Header non definiti");
    return;
  }


  const headers = new Headers({
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    "X-UT-SID": xUtSid
  });

  let body = JSON.stringify({ bid : buyNowPrice });


  // Invia la richiesta PUT
  try{
    const response = await fetch(buyNowUrl, {
      method: "PUT",
      headers: headers,
      body: body
    });
    if (response.ok) {
      const data = await response.json();
      carteAcquistate += 1;
      idCarteAcquistate.push(itemId);
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Ho acquistato una carta al prezzo di: ' + buyNowPrice});
      chrome.runtime.sendMessage({ tipo: 'CARTA_ACQUISTATA', valore: carteAcquistate});
      
    } else {
      console.error("Errore nell'acquisto:", response.status, response.statusText);
    }
  } catch (error) {
    console.error("Errore durante l'invio della richiesta di acquisto:", error);
  }

}

async function sendToTransferList() {
  let transferListUrl = 'https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/item';

  if (!transferListUrl || !searchHeaders) {
    console.error("URL o Header non definiti per la lista trasferimenti");
    return;
  }

  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    "sec-ch-ua": "\"Chromium\";v=\"142\", \"Google Chrome\";v=\"142\", \"Not_A Brand\";v=\"99\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "X-UT-SID": xUtSid
  });

  let body = {itemData: []};
  for(id of idCarteAcquistate){
      body.itemData.push({
        "id": id,
        "pile": "trade"
      })
      let bodyJson = JSON.stringify(body);

      // Invio la richiesta PUT
      try{
        const response = await fetch(transferListUrl, {
          method: "PUT",
          headers: headers,
          body: bodyJson
        });
        if (response.ok) {
          chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Carte inviate alla lista trasferimenti'});
        }
      }catch (error) {
        chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Errore durante l\'invio alla lista trasferimenti'});
        console.error("Errore durante l'invio alla lista trasferimenti:", error);
      }
    }
  
}



async function sendFodderResearchRequest(){


  let i = 0
  while(start==true && i < numeroTentativi){

    //ad inizio e alla fine del primo ciclo, ricarico la lista 
    if(i==0 || i==listaFodder.length-1){
      await getFdderList()
    }

    const next = getNextFodder();

    //costruisco l'url:
    let fodderDefId = next.pid;
    let fodderPrice = Math.floor((next.price * 0.9) / 100) * 100; //calcolo il 10% ed arrotondo alla centinaia più vicina per difetto

    //Definisco l'URL di base
    const baseUrl = "https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/transfermarket";

    //Creo un oggetto URL
    const url = new URL(baseUrl);

    //Imposto i parametri che servono
    url.searchParams.set("num", "21");
    url.searchParams.set("start", "0"); 
    url.searchParams.set("type", "player");
    url.searchParams.set("maxb", fodderPrice);
    url.searchParams.set("maskedDefId", fodderDefId);

    //Ottiene l'URL finale come stringa
    const searchUrlCompleto = url.href;
  

    try {
      // Controlla che l'URL e l'header siano definiti
      if (!searchUrlCompleto || !searchHeaders) {
        console.error("URL o Header non definiti");
        return;
      }

      if(searchUrlCompleto.includes('start=0') && !searchUrl.includes('maxb=200')) searchUrl = searchUrl.replace('start=0', 'start=200')
      else if(searchUrlCompleto.includes('start=200')) searchUrl = searchUrl.replace('start=200', 'start=0')
          

      const headers = new Headers({
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      "X-UT-SID": xUtSid
      });

      // Invia la richiesta GET
      const response = await fetch(searchUrlCompleto, {
        method: "GET",
        headers: headers,
      });
      

      // Controlla la risposta
      if (response.ok) {
        const data = await response.json();
        if(data.auctionInfo && data.auctionInfo.length >0){
          chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Ho trovato ' + data.auctionInfo.length + ' carte'});
          idCarteAcquistate= [];

          for (const auction of data.auctionInfo) {
            let tradeId = auction.tradeId;
            let buyNowPrice = auction.buyNowPrice;
            let itemDataId = auction.itemData.id;
            
            await sendBuyNowRequest(tradeId, buyNowPrice,itemDataId);
            
          };

          //invio alla lista trasferimenti
          //if(idCarteAcquistate.length > 0) 
          if(idCarteAcquistate.length > 0) {
            await sendToTransferList();
            await sellFodder(next.price);
          }

        } else if(!data.auctionInfo){
          console.error("Errore nella ricerca:", response.status, response.statusText);
        }
      }
    }catch (error) {
      console.error("Errore durante l'invio della richiesta:", error);
    }

    //sleep
    //aggiorno contatore tentativi rimasti
    chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1)});
    let randomValue;
    if((i+1)%50 == 0 && i!=numeroTentativi-1) {
      randomValue = getRandomInRange(300, 420) ; //sleep random tra 5 minuti e 7 minuti ogni 50 tentativi
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Cool down di: ' + randomValue + ' sec'});
    }
      else if((i+1)%5 == 0) randomValue = getRandomInRange(2,5) ; //sleep random tra 1 e 3 secondi ogni 5 tentativi
    else randomValue = Math.random() + 0.5; //sleep random tra 0.5 e 1 secondi
    
    await sleep(randomValue * 1000);
    i++;
  }

}



async function getFdderList(){


  let futWizUrl = 'http://localhost:3000/fut/fodder';

  if (!futWizUrl) {
    console.error("URL o Header non definiti per FUTWIZZ");
    return;
  }

  const headers = new Headers({
    "accept": "text/x-component",
    "accept-language": "it-IT,it;q=0.8",
    "content-type": "text/plain;charset=UTF-8",
    "next-action": "7f738887f1d746cf4daefba82830317ddb96a802c6",
    "next-router-state-tree":
      "%5B%22%22%2C%7B%22children%22%3A%5B%5B%22game%22%2C%22fc26%22%2C%22d%22%5D%2C%7B%22children%22%3A%5B%22players%22%2C%7B%22children%22%3A%5B%22__PAGE__%3F%7B%5C%22sort%5C%22%3A%5C%22price%5C%22%2C%5C%22direction%5C%22%3A%5C%22asc%5C%22%2C%5C%22rating_min%5C%22%3A%5C%2284%5C%22%2C%5C%22rating_max%5C%22%3A%5C%2284%5C%22%2C%5C%22priceRange_min%5C%22%3A%5C%22200%5C%22%7D%22%2C%7B%7D%2C%22%2Ffc26%2Fplayers%3Fsort%3Dprice%26direction%3Dasc%26rating_min%3D84%26rating_max%3D84%26priceRange_min%3D200%22%2C%22refresh%22%5D%7D%5D%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D",
    "priority": "u=1, i",
    "sec-ch-ua": "\"Chromium\";v=\"142\", \"Brave\";v=\"142\", \"Not_A Brand\";v=\"99\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-gpc": "1"
  });

  const body = [
    26,
    {
      mode: "search",
      filters: {
        rating: { min: 84, max: 84 },
        priceRange: { min: 200, max: 15000000 }
      },
      search: "$undefined",
      pagination: { page: 1, limit: 40 },
      sorting: { field: "price", direction: "asc" }
    }
  ];

  let bodyJson = JSON.stringify({body});

  // Invio la richiesta PUT
  try{
    const response = await fetch(futWizUrl, {
      method: "GET",
      headers: headers,
      referrer: futWizUrl,
    });
    if (response.ok) {
      const data = await response.json();

      //se trovo risultati, aggiungo alla lista dei fodder
      if (Array.isArray(data.data) && data?.data?.length) {
      //Estraggo gli id interni delle carte ed i relativi prezzi
      data.data.forEach(item => {
        let fodder = {
          "pid" : item.pid,
          "price" : item.prices.console.bin
        }
        listaFodder.push(fodder)
      });

      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Ho recuperato la lista dei fodder da FUTWIZ'});
    }
    }}catch (error) {
    chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Errore durante recupero lista dei fodder da FUTWIZ'});
    console.error("Errore durante recupero lista dei fodder da FUTWIZ:", error);
  }


}




chrome.runtime.onMessage.addListener(async (message) => {
  if (message.tipo === 'FODDER_MODE') {
    ricercaFodder = message.valore;
  }
})

function getNextFodder() {
  const fodder = listaFodder[indexFodder];
  indexFodder = (indexFodder + 1) % listaFodder.length;
  return fodder;
}


async function sellFodder(price) {

  sellUrl = "https://utas.mob.v5.prd.futc-ext.gcp.ea.com/ut/game/fc26/auctionhouse"
  if (!xUtSid) {
    console.error("X-UT-SID non definito");
    return;
  }

  for(id of idCarteAcquistate){

    const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });

    const body = {
      "buyNowPrice": price,
      "duration": 3600,
      "itemData": {
        "id": id
      },
      "startingBid": price-100
    };

    const bodyJson = JSON.stringify(body);

    try {
      const response = await fetch(sellUrl, {
        method: "POST",
        headers: headers,
        body: bodyJson,
        referrer: "https://www.ea.com/",
        mode: "cors",
        credentials: "omit"
      });

      if (response.ok) {
        const data = await response.json();

        chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Carta messa in vendita a: ' + price + ' crediti'});
      } else {
        console.error(`Errore HTTP: ${response.status} ${response.statusText}`);
        chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Errore nella messa in vnedita'});
      }

    } catch (error) {
      console.error("Errore durante la richiesta all'Auction House:", error);
    }
      
  }

  
}

