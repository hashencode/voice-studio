import 'package:flutter/foundation.dart';

import '../features/processing/desktop_job.dart';

abstract interface class DesktopHomeModel implements Listenable {
  bool get loading;
  bool get importing;
  bool get engineAvailable;
  String get engineAvailabilityMessage;
  String? get errorMessage;
  String? get noticeMessage;
  List<DesktopProcessingJob> get jobs;

  Future<void> load();
  Future<void> importMeeting();
}
