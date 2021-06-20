from django.conf import settings
from django.db import models
from django.utils import timezone
import json


class LoggedInUser(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL,
                                related_name='logged_in_user',
                                on_delete=models.CASCADE)


class Player(models.Model):
    name = models.CharField(max_length=50)
    points = models.IntegerField(default=0)
    is_logged_in = models.BooleanField(default=False)
    path = models.CharField(max_length=1000, default="{'word_list': ['word1']}")

    def add_to_path(self, word):
        try:
            path = json.loads(self.path)
            path['word_list'] = list(path['word_list'])
            path['word_list'].append(word)
            self.path = json.dumps(path)
        except:
            path = {"word_list": ['word1']}
            self.path = json.dumps(path)

    def get_path_list(self):
        path = json.loads(self.path)

        return list(path['word_list'])

    def reset_path_list(self):
        path = json.loads(self.path)
        path['word_list'] = []
        self.path = json.dumps(path)

    def __str__(self):
        return self.name


class TargetWord(models.Model):
    word = models.CharField(max_length=30)
    completed_in = models.IntegerField(default=0)
    completed_from = models.CharField(max_length=30)
    datetime = models.DateTimeField(default=timezone.now, db_index=True)
    path = models.CharField(max_length=1000, default="{'word_list': ['word1']}")

    def get_path_list(self):
        path = json.loads(self.path)

        return list(path['word_list'])

    def __str__(self):
        return self.word
