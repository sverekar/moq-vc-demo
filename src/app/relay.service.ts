import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { catchError, map, Observable, of } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class RelayService {

  private URL: string = 'https://172-236-78-145.ip.linodeusercontent.com:9928/';

  private relayURL: string = this.URL + 'RelayLocation/'

  private announceURL: string = this.URL + 'Announces/'

  constructor(private http: HttpClient) { }

  getCurrentPosition(): Promise<any> {
    return new Promise((resolve, reject) => {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(resp => {
          resolve({lng: resp.coords.longitude, lat: resp.coords.latitude});
        },
        err => {
          console.warn(`Unable to find current location due to ${err.message}`)
          resolve(undefined);
        });
      } else {
        console.warn(`Navigator geolocation not supported / enabled !`)
        resolve(undefined);
      }
    });
  }

  getRelays(mock?: boolean) {

    // For testing: comment it out later
    if (mock) {
      return of([{ 'url': 'https://moq-akamai-relay.akalab.ca:8843/moq', 'coordinates': [80.2705, 13.0843] ,'zone': 'maa'}])
    }

    const headerDict = {
      'Accept': 'application/json',
      'Authorization': 'Basic SERCX0FETUlOOnBhc3N3b3Jk'
    }

    const requestOptions = {
      headers: new HttpHeaders(headerDict),
    };

    return this.http.get<Array<{ url: string, coordinates:Array<number>, zone: string}>>(this.relayURL, requestOptions).pipe(
      catchError((err: any) => {
        console.error(`Error getting relay endpoints, ${err.message}`)
        return [];
      })
    );
  }

  getPeersList(mock?: boolean): Observable<Set<string>> {

    // For testing: comment it out later
    if (mock) {
      return of(new Set<string>().add('Guest'))
    }

    const headerDict = {
      'Accept': 'application/json',
      'Authorization': 'Basic SERCX0FETUlOOnBhc3N3b3Jk'
    }

    const requestOptions = {
      headers: new HttpHeaders(headerDict),
    };

    return this.http.get<Array<{ tracknamespace: string}>>(this.announceURL, requestOptions).pipe(
      map(resp => resp.map((x: any) => x.tracknamespace)),
      map(resp =>  new Set(resp)),
      catchError((err: any) => {
        console.error(`Error getting subscribers list due to ${err.message}`)
        return [];
      })
    );
  }
}
