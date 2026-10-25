import Foundation
import EventKit

func output(_ value:Any){if let data=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]),let text=String(data:data,encoding:.utf8){print(text)}}
func date(_ value:Any?) throws -> Date {guard let text=value as? String else{throw Failure.message("일시가 필요합니다.")};let formatter=ISO8601DateFormatter();if let d=formatter.date(from:text){return d};formatter.formatOptions=[.withInternetDateTime,.withFractionalSeconds];guard let d=formatter.date(from:text) else{throw Failure.message("ISO 8601 일시가 필요합니다.")};return d}
enum Failure:Error {case message(String)}
let store=EKEventStore()
func run(_ request:[String:Any]) async throws -> [String:Any]{
 guard try await store.requestFullAccessToEvents() else{throw Failure.message("macOS 캘린더 접근을 허용해 주세요.")}
 let op=request["op"] as? String ?? "calendars"
 let calendars=store.calendars(for:.event)
 if op=="calendars" {return ["calendars":calendars.map{["id":$0.calendarIdentifier,"title":$0.title,"source":$0.source.title,"writable":$0.allowsContentModifications] as [String:Any]}]}
 guard let calendarId=request["calendarId"] as? String,let calendar=calendars.first(where:{$0.calendarIdentifier==calendarId}) else{throw Failure.message("선택한 캘린더를 찾을 수 없습니다.")}
 let start=try date(request["start"]),end=try date(request["end"])
 guard end>start,end.timeIntervalSince(start)<86400*367 else{throw Failure.message("종료는 시작 이후, 조회 범위는 1년 이내여야 합니다.")}
 let formatter=ISO8601DateFormatter()
 if op=="validate" {return ["valid":true,"calendarWritable":calendar.allowsContentModifications]}
 if op=="events" {
  let events=store.events(matching:store.predicateForEvents(withStart:start,end:end,calendars:[calendar])).sorted{$0.startDate<$1.startDate}
  return ["events":events.prefix(200).map{event -> [String:Any] in
   let notes=event.notes ?? ""
   let marker=notes.components(separatedBy:"\n").first(where:{$0.hasPrefix("LocalMeeting-ID: ")})
   let uid=marker?.replacingOccurrences(of:"LocalMeeting-ID: ",with:"") ?? ""
   return ["id":event.eventIdentifier ?? "","title":event.title ?? "","start":formatter.string(from:event.startDate),"end":formatter.string(from:event.endDate),"allDay":event.isAllDay,"uid":UUID(uuidString:uid) != nil ? uid : "","notes":UUID(uuidString:uid) != nil ? notes.components(separatedBy:"\n\nLocalMeeting-ID:")[0] : ""]
  } ]
 }
 guard op=="save",calendar.allowsContentModifications else{throw Failure.message("수정 가능한 캘린더가 아닙니다.")}
 guard let title=request["title"] as? String,!title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,title.count<501,let uid=request["uid"] as? String,UUID(uuidString:uid) != nil else{throw Failure.message("일정 제목과 유효한 고유 ID가 필요합니다.")}
 let marker="LocalMeeting-ID: \(uid)"
 var existing:EKEvent?=nil
 if let eventId=request["eventId"] as? String,let event=store.event(withIdentifier:eventId){guard event.notes?.contains(marker)==true else{throw Failure.message("이 플러그인에서 만든 일정만 갱신할 수 있습니다.")};existing=event}
 if existing==nil {existing=store.events(matching:store.predicateForEvents(withStart:start.addingTimeInterval(-86400),end:end.addingTimeInterval(86400),calendars:[calendar])).first{$0.notes?.contains(marker)==true}}
 let event=existing ?? EKEvent(eventStore:store)
 event.calendar=calendar;event.title=title;event.startDate=start;event.endDate=end;event.notes=(request["notes"] as? String ?? "")+"\n\n"+marker
 try store.save(event,span:.thisEvent,commit:true)
 return ["eventId":event.eventIdentifier ?? "","calendarId":calendar.calendarIdentifier,"uid":uid,"saved":true]
}
Task {
 do {guard let line=readLine(),let data=line.data(using:.utf8),let request=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw Failure.message("잘못된 요청")};output(try await run(request));exit(0)}
 catch Failure.message(let message){output(["error":message]);exit(1)}
 catch {output(["error":error.localizedDescription]);exit(1)}
}
RunLoop.main.run()
